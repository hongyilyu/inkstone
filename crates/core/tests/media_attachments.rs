//! `media/upload` (JSON-RPC) + `GET /media/{id}` (HTTP) — the first real
//! consumer of the ADR-0058 media substrate. Upload decodes client-supplied
//! base64 bytes and persists them (bytes on disk, row in SQLite); the HTTP
//! route serves them back with the stored `mime` as Content-Type. Unknown ids
//! and rows pointing at missing bytes both 404 (the latter loudly, per
//! ADR-0058); invalid base64 and >10 MB decoded payloads reject `-32602`.
//!
//! The send path (chat-image-attachments slice 2): `thread/create` /
//! `run/post_message` accept `attachment_ids` from prior uploads, persisting
//! one attachment part per id in the initial-run transaction; `thread/get`
//! rehydrates the user message as `[text, attachment…]` segments (ADR-0045
//! fifth kind). An unknown id rejects `-32602` with zero rows persisted.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, Ws, next_text};

/// Read frames until one whose `id` matches `want_id` (media has no
/// notifications today, but keep the thread_get.rs idiom).
async fn read_response_with_id(ws: &mut Ws, want_id: i64) -> serde_json::Value {
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("frame is JSON: {e} — body: {body}"));
        if v["id"] == serde_json::json!(want_id) {
            return v;
        }
    }
}

async fn send(ws: &mut Ws, frame: String) {
    ws.send(Message::Text(frame.into()))
        .await
        .expect("send frame");
}

/// Build a `media/upload` request frame with the given params.
fn upload_frame(id: i64, params: serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "media/upload",
        "params": params,
    })
    .to_string()
}

#[test]
fn media_upload_round_trips_bytes_over_http() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    // A few hundred distinctive bytes (not valid PNG data — Core never sniffs,
    // per the ADR-0058 scope boundary, so any bytes round-trip).
    let bytes: Vec<u8> = (0..300u32).map(|i| (i % 251) as u8).collect();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    let media_id = rt.block_on(async {
        let mut ws = core.connect().await;
        send(
            &mut ws,
            upload_frame(
                1,
                serde_json::json!({
                    "bytes_base64": BASE64.encode(&bytes),
                    "mime": "image/png",
                    "width": 4,
                    "height": 3,
                }),
            ),
        )
        .await;
        let resp = read_response_with_id(&mut ws, 1).await;
        assert!(
            resp.get("error").is_none(),
            "media/upload succeeds — {resp}"
        );
        let media_id = resp["result"]["media_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.media_id is a string — {resp}"))
            .to_string();
        assert!(!media_id.is_empty(), "media_id is non-empty — {resp}");
        ws.close(None).await.ok();
        media_id
    });

    // GET /media/{id} → 200, stored mime as Content-Type, byte-exact body.
    let got = reqwest::blocking::get(format!("{}/media/{media_id}", core.http_url()))
        .expect("GET /media/{id} succeeds");
    assert_eq!(got.status().as_u16(), 200, "GET /media/{{id}} is 200");
    assert_eq!(
        got.headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("image/png"),
        "Content-Type is the stored mime"
    );
    // `nosniff` pins the response to the stored mime — without it a browser may
    // sniff crafted bytes into text/html (stored XSS via the unvalidated mime).
    assert_eq!(
        got.headers()
            .get("x-content-type-options")
            .and_then(|v| v.to_str().ok()),
        Some("nosniff"),
        "X-Content-Type-Options forbids mime sniffing"
    );
    let body = got.bytes().expect("body bytes");
    assert_eq!(body.as_ref(), bytes.as_slice(), "bytes round-trip exactly");

    // A valid row whose file is gone from disk → 404 (loud read error, ADR-0058).
    // The harness points INKSTONE_MEDIA_DIR at <workspace>/media, and
    // `insert_media` stores the bare media id as the flat-root filename.
    let stored = workspace.path().join("media").join(&media_id);
    assert!(stored.exists(), "uploaded bytes live under the media root");
    std::fs::remove_file(&stored).expect("delete stored file");
    let gone = reqwest::blocking::get(format!("{}/media/{media_id}", core.http_url()))
        .expect("GET after file delete succeeds");
    assert_eq!(
        gone.status().as_u16(),
        404,
        "a row pointing at missing bytes is a 404"
    );
}

#[test]
fn media_get_unknown_id_is_404() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let got = reqwest::blocking::get(format!("{}/media/unknown-id", core.http_url()))
        .expect("GET /media/unknown-id succeeds");
    assert_eq!(got.status().as_u16(), 404, "unknown media id is 404");
}

/// Upload `bytes` with the given metadata and return the new `media_id`.
async fn upload(ws: &mut Ws, id: i64, params: serde_json::Value) -> String {
    send(ws, upload_frame(id, params)).await;
    let resp = read_response_with_id(ws, id).await;
    assert!(resp.get("error").is_none(), "media/upload succeeds — {resp}");
    resp["result"]["media_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.media_id is a string — {resp}"))
        .to_string()
}

/// Subscribe to `run_id` and drain the event tail until `done`, so the Run
/// settles before the test reads the Thread back (thread_get.rs idiom).
async fn drain_run_to_done(ws: &mut Ws, req_id: i64, run_id: &str) {
    send(
        ws,
        format!(
            r#"{{"jsonrpc":"2.0","id":{req_id},"method":"run/subscribe","params":{{"run_id":"{run_id}"}}}}"#
        ),
    )
    .await;
    let _sub_resp = read_response_with_id(ws, req_id).await;
    loop {
        let body = next_text(ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("tail frame is JSON: {e} — body: {body}"));
        if v["params"]["event"]["kind"] == serde_json::json!("done") {
            break;
        }
    }
}

/// `thread/get` and return the result object.
async fn thread_get(ws: &mut Ws, req_id: i64, thread_id: &str) -> serde_json::Value {
    send(
        ws,
        format!(
            r#"{{"jsonrpc":"2.0","id":{req_id},"method":"thread/get","params":{{"thread_id":"{thread_id}"}}}}"#
        ),
    )
    .await;
    let resp = read_response_with_id(ws, req_id).await;
    assert!(
        resp.get("error").is_none(),
        "thread/get is not an error — {resp}"
    );
    resp["result"].clone()
}

/// The send path persists attachment parts and `thread/get` rehydrates them:
/// `thread/create` with two uploaded ids yields a user message whose segments
/// are `[text, attachment(id1), attachment(id2)]` in that order — each
/// attachment carrying `media_id` + `mime`, and `width`/`height` exactly when
/// the upload supplied them (omitted, not null, otherwise). A follow-up
/// `run/post_message` with one id yields the same shape on its user message.
#[test]
fn send_with_attachment_ids_rehydrates_attachment_segments() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Two uploads: the first with dimensions, the second without — so both
        // the present and the omitted width/height branches are exercised.
        let id1 = upload(
            &mut ws,
            1,
            serde_json::json!({
                "bytes_base64": BASE64.encode(b"first image bytes"),
                "mime": "image/png",
                "width": 4,
                "height": 3,
            }),
        )
        .await;
        let id2 = upload(
            &mut ws,
            2,
            serde_json::json!({
                "bytes_base64": BASE64.encode(b"second image bytes"),
                "mime": "image/jpeg",
            }),
        )
        .await;

        // thread/create carrying both attachment ids.
        let create_frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "thread/create",
            "params": { "prompt": "look at these", "attachment_ids": [id1, id2] },
        })
        .to_string();
        send(&mut ws, create_frame).await;
        let create = read_response_with_id(&mut ws, 3).await;
        assert!(
            create.get("error").is_none(),
            "thread/create with valid attachment_ids succeeds — {create}"
        );
        let thread_id = create["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — {create}"))
            .to_string();
        let run_id = create["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — {create}"))
            .to_string();
        drain_run_to_done(&mut ws, 4, &run_id).await;

        let got = thread_get(&mut ws, 5, &thread_id).await;
        let user = &got["messages"][0];
        assert_eq!(user["role"], serde_json::json!("user"), "messages[0] is the user turn — {got}");
        let segments = user["segments"]
            .as_array()
            .unwrap_or_else(|| panic!("user segments is an array — {got}"));
        assert_eq!(
            segments.len(),
            3,
            "user segments are [text, attachment, attachment] — {got}"
        );
        assert_eq!(
            segments[0],
            serde_json::json!({ "kind": "text", "text": "look at these" }),
            "segment[0] is the prompt text — {got}"
        );
        // Attachment segments follow in attachment_ids order. The first carries
        // the uploaded dimensions; the second OMITS width/height (not null).
        assert_eq!(
            segments[1],
            serde_json::json!({
                "kind": "attachment",
                "media_id": id1,
                "mime": "image/png",
                "width": 4,
                "height": 3,
            }),
            "segment[1] is the first attachment with dimensions — {got}"
        );
        assert_eq!(
            segments[2],
            serde_json::json!({
                "kind": "attachment",
                "media_id": id2,
                "mime": "image/jpeg",
            }),
            "segment[2] is the second attachment, width/height omitted — {got}"
        );

        // run/post_message on the same thread with ONE attachment id → the new
        // user message rehydrates the same [text, attachment] shape.
        let post_frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "run/post_message",
            "params": {
                "thread_id": thread_id,
                "prompt": "and this one again",
                "attachment_ids": [id1],
            },
        })
        .to_string();
        send(&mut ws, post_frame).await;
        let post = read_response_with_id(&mut ws, 6).await;
        assert!(
            post.get("error").is_none(),
            "run/post_message with a valid attachment_id succeeds — {post}"
        );
        let run2 = post["result"]["run_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.run_id is a string — {post}"))
            .to_string();
        drain_run_to_done(&mut ws, 7, &run2).await;

        let got = thread_get(&mut ws, 8, &thread_id).await;
        let messages = got["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("messages is an array — {got}"));
        assert_eq!(messages.len(), 4, "two turns → four messages — {got}");
        let user2 = &messages[2];
        assert_eq!(user2["role"], serde_json::json!("user"), "messages[2] is the second user turn — {got}");
        let segments = user2["segments"]
            .as_array()
            .unwrap_or_else(|| panic!("second user segments is an array — {got}"));
        assert_eq!(
            segments.as_slice(),
            &[
                serde_json::json!({ "kind": "text", "text": "and this one again" }),
                serde_json::json!({
                    "kind": "attachment",
                    "media_id": id1,
                    "mime": "image/png",
                    "width": 4,
                    "height": 3,
                }),
            ],
            "posted message rehydrates [text, attachment] — {got}"
        );

        ws.close(None).await.ok();
    });
}

/// An unknown attachment id rejects `-32602` with ZERO rows persisted:
/// `run/post_message` leaves the thread's message count unchanged, and
/// `thread/create` mints no thread at all.
#[test]
fn unknown_attachment_id_rejects_invalid_params_with_zero_rows() {
    let workspace = Workspace::new();
    let core = workspace.core().worker_fixture("slow-worker.ts").spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // Seed one real thread (no attachments) to post against.
        send(
            &mut ws,
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/create","params":{"prompt":"hi"}}"#
                .to_string(),
        )
        .await;
        let create = read_response_with_id(&mut ws, 1).await;
        let thread_id = create["result"]["thread_id"]
            .as_str()
            .unwrap_or_else(|| panic!("result.thread_id is a string — {create}"))
            .to_string();

        // run/post_message with a nonexistent media id → -32602, zero new rows.
        let post_frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "run/post_message",
            "params": {
                "thread_id": thread_id,
                "prompt": "with a ghost attachment",
                "attachment_ids": ["nonexistent"],
            },
        })
        .to_string();
        send(&mut ws, post_frame).await;
        let post = read_response_with_id(&mut ws, 2).await;
        assert_eq!(
            post["error"]["code"],
            serde_json::json!(-32602),
            "an unknown attachment id is invalid_params — {post}"
        );

        // The rejected post persisted NOTHING: still the seed turn's 2 messages.
        let got = thread_get(&mut ws, 3, &thread_id).await;
        let messages = got["messages"]
            .as_array()
            .unwrap_or_else(|| panic!("messages is an array — {got}"));
        assert_eq!(
            messages.len(),
            2,
            "rejected post_message added no messages — {got}"
        );

        // thread/create with a nonexistent media id → -32602, no thread minted.
        let create_frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "thread/create",
            "params": { "prompt": "ghost thread", "attachment_ids": ["nonexistent"] },
        })
        .to_string();
        send(&mut ws, create_frame).await;
        let create = read_response_with_id(&mut ws, 4).await;
        assert_eq!(
            create["error"]["code"],
            serde_json::json!(-32602),
            "thread/create with an unknown attachment id is invalid_params — {create}"
        );

        send(
            &mut ws,
            r#"{"jsonrpc":"2.0","id":5,"method":"thread/list","params":{}}"#.to_string(),
        )
        .await;
        let list = read_response_with_id(&mut ws, 5).await;
        let threads = list["result"]["threads"]
            .as_array()
            .unwrap_or_else(|| panic!("threads is an array — {list}"));
        assert_eq!(
            threads.len(),
            1,
            "the rejected create minted no thread — {list}"
        );

        ws.close(None).await.ok();
    });
}

#[test]
fn media_upload_invalid_base64_rejects_invalid_params() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;
        send(
            &mut ws,
            upload_frame(
                1,
                serde_json::json!({
                    "bytes_base64": "not-base64!!!",
                    "mime": "image/png",
                }),
            ),
        )
        .await;
        let resp = read_response_with_id(&mut ws, 1).await;
        assert_eq!(
            resp["error"]["code"],
            serde_json::json!(-32602),
            "invalid base64 is invalid_params — {resp}"
        );
        ws.close(None).await.ok();
    });
}

#[test]
fn media_upload_oversize_rejects_invalid_params() {
    let workspace = Workspace::new();
    let core = workspace.core().spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;
        // 10 MB + 1 decoded — one byte over the cap. The base64 text is ~14 MB,
        // under tungstenite's 16 MiB default frame cap.
        let oversize = vec![0u8; 10 * 1024 * 1024 + 1];
        send(
            &mut ws,
            upload_frame(
                1,
                serde_json::json!({
                    "bytes_base64": BASE64.encode(&oversize),
                    "mime": "image/png",
                }),
            ),
        )
        .await;
        let resp = read_response_with_id(&mut ws, 1).await;
        assert_eq!(
            resp["error"]["code"],
            serde_json::json!(-32602),
            "oversize decoded payload is invalid_params — {resp}"
        );
        ws.close(None).await.ok();
    });
}
