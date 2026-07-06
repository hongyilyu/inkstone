//! `media/upload` (JSON-RPC) + `GET /media/{id}` (HTTP) — the first real
//! consumer of the ADR-0058 media substrate. Upload decodes client-supplied
//! base64 bytes and persists them (bytes on disk, row in SQLite); the HTTP
//! route serves them back with the stored `mime` as Content-Type. Unknown ids
//! and rows pointing at missing bytes both 404 (the latter loudly, per
//! ADR-0058); invalid base64 and >10 MB decoded payloads reject `-32602`.

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
