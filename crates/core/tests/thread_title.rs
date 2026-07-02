//! `thread/create` fires a one-shot, non-Run title Worker (ADR-0046): with a
//! connected provider its sanitized output overwrites `threads.title` (visible
//! via `thread/list`); with no credential, or empty/whitespace output, the
//! prompt-derived placeholder stays. On a successful generation Core also frames
//! a `thread/titled` notification onto the creating connection (ADR-0047) so the
//! sidebar updates live, without a `thread/list` poll.
//!
//! The title Worker is pointed at `title-worker.ts` via
//! `INKSTONE_TITLE_WORKER_CMD`; the Run's own Worker stays on `slow-worker.ts`
//! (via `worker_fixture`) so thread creation still succeeds. A credential is
//! seeded into an `INKSTONE_CREDENTIALS_DIR` so the strict token gate
//! (`Ok(Some)`) is satisfied — the no-credential test omits it.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, fixture_cmd, next_text};

/// Write a non-expired `openai-codex` credential into `dir` so Core's token gate
/// resolves `Ok(Some(_))`. Mirrors `credentials::StoredCredential`'s on-disk
/// shape (internally tagged: `kind` + the OAuth fields).
fn seed_codex_credential(dir: &std::path::Path) {
    std::fs::create_dir_all(dir).expect("create credentials dir");
    let body = r#"{
        "kind": "oauth",
        "access": "tok_access",
        "refresh": "tok_refresh",
        "expires": 9999999999999,
        "account_id": "acct_test"
    }"#;
    std::fs::write(dir.join("openai-codex.json"), body).expect("write credential file");
}

/// Send `thread/create({prompt})` and return its `thread_id`.
async fn create_thread(ws: &mut common::Ws, id: u64, prompt: &str) -> String {
    let create = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/create",
        "params": { "prompt": prompt },
    })
    .to_string();
    ws.send(Message::Text(create.into()))
        .await
        .expect("send thread/create frame");
    let body = next_text(ws).await;
    let v: serde_json::Value = serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("create response is JSON: {e} — body: {body}"));
    assert!(
        v.get("error").is_none(),
        "thread/create with a real prompt is not an error — body: {body}"
    );
    v["result"]["thread_id"]
        .as_str()
        .unwrap_or_else(|| panic!("result.thread_id is a string — body: {body}"))
        .to_string()
}

/// Read text frames off the SAME socket until a JSON-RPC notification with
/// `method == want_method` arrives, returning its `params`. Bounded by `budget`
/// so a never-arriving frame fails fast rather than hanging. Frames for other
/// methods (and any responses) are skipped. `None` if the budget elapses without
/// the wanted notification — used both to assert a push DID arrive (expect
/// `Some`) and that it did NOT (expect `None`).
async fn read_until_method(
    ws: &mut common::Ws,
    want_method: &str,
    budget: Duration,
) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let frame = match tokio::time::timeout(remaining, ws.next()).await {
            // Budget elapsed: the legitimate "no wanted frame arrived" outcome —
            // the only case an absence assertion (`expect None`) should accept.
            Err(_) => return None,
            // Socket closed / read error is a TRANSPORT failure, not a quiet
            // channel: make it loud so an absence assertion can't pass vacuously
            // on a dead connection (CodeRabbit #210).
            Ok(None) => panic!("socket closed before a `{want_method}` frame arrived"),
            Ok(Some(Err(e))) => panic!("websocket read error awaiting `{want_method}`: {e}"),
            Ok(Some(Ok(f))) => f,
        };
        let Message::Text(text) = frame else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if v["method"].as_str() == Some(want_method) {
            return Some(v["params"].clone());
        }
    }
}

/// Read the current title of `thread_id` via `thread/list`, or `None` if the
/// thread is absent from the feed. Reads by request `id`: an unsolicited
/// `thread/titled` notification (ADR-0047) can interleave on the socket between
/// the request and its response, so frames that aren't the response for `id` are
/// skipped.
async fn title_of(ws: &mut common::Ws, id: u64, thread_id: &str) -> Option<String> {
    let list = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "thread/list",
        "params": {},
    })
    .to_string();
    ws.send(Message::Text(list.into()))
        .await
        .expect("send thread/list frame");
    // Skip any interleaved notification (no `id`) until the response for `id`.
    let v = loop {
        let body = next_text(ws).await;
        let frame: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("thread/list response is JSON: {e} — body: {body}"));
        if frame["id"].as_u64() == Some(id) {
            break frame;
        }
    };
    let threads = v["result"]["threads"]
        .as_array()
        .unwrap_or_else(|| panic!("result.threads is an array — body: {v}"));
    threads
        .iter()
        .find(|t| t["id"].as_str() == Some(thread_id))
        .map(|t| {
            t["title"]
                .as_str()
                .unwrap_or_else(|| panic!("thread.title is a string — body: {v}"))
                .to_string()
        })
}

/// Poll `thread/list` until `thread_id`'s title equals `want`, up to a bounded
/// retry budget. Returns `true` on a match, `false` if it never updated.
async fn poll_until_title(
    ws: &mut common::Ws,
    base_id: u64,
    thread_id: &str,
    want: &str,
) -> bool {
    for attempt in 0..40 {
        if title_of(ws, base_id + attempt, thread_id).await.as_deref() == Some(want) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

/// A connected provider's title Worker output, once sanitized, overwrites the
/// placeholder; `thread/list` reflects the new title.
#[test]
fn generated_title_overwrites_placeholder() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    seed_codex_credential(&creds_dir);

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TITLE_WORKER_CMD", fixture_cmd("title-worker.ts", &[]))
        // DIRTY model output: a reasoning block + a newline + wrapping quotes.
        // Asserting the SANITIZED result proves the create→titler→sanitize→update
        // wiring — a regression that dropped `sanitize_title` and wrote `acc`
        // verbatim would store this raw blob and fail.
        .env(
            "INKSTONE_TITLE_FIXTURE_OUTPUT",
            "<think>the user wants a budget plan</think>\n\"Budget planning for Q3\"",
        )
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let prompt = "i need to plan the q3 budget across all teams and figure out headcount";
        let thread_id = create_thread(&mut ws, 1, prompt).await;

        // The initial placeholder is the word-boundary slug of the prompt
        // (ADR-0048): collapsed to one line, trimmed to the last whole word
        // within 32 scalars. This long prompt backs off mid-sentence.
        let placeholder = title_of(&mut ws, 100, &thread_id)
            .await
            .expect("created thread is in the feed");
        assert_eq!(
            placeholder, "i need to plan the q3 budget",
            "initial title is the prompt-derived word-boundary slug"
        );

        // The titler overwrites it with the sanitized fixture output.
        let updated = poll_until_title(&mut ws, 1000, &thread_id, "Budget planning for Q3").await;
        assert!(
            updated,
            "title was overwritten with the generated title within the retry budget"
        );

        ws.close(None).await.ok();
    });
}

/// Whitespace-only title output sanitizes to `None`, so the placeholder stays.
#[test]
fn whitespace_output_keeps_placeholder() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    seed_codex_credential(&creds_dir);

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TITLE_WORKER_CMD", fixture_cmd("title-worker.ts", &[]))
        .env("INKSTONE_TITLE_FIXTURE_EMPTY", "1")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let prompt = "draft the offsite agenda";
        let thread_id = create_thread(&mut ws, 1, prompt).await;

        // Whitespace output never updates, so any reasonable wait suffices to
        // rule out a race: give the titler ample time to run, then assert the
        // placeholder is unchanged.
        tokio::time::sleep(Duration::from_millis(600)).await;
        let title = title_of(&mut ws, 100, &thread_id)
            .await
            .expect("created thread is in the feed");
        assert_eq!(
            title, prompt,
            "whitespace title output sanitizes to None → placeholder kept"
        );

        ws.close(None).await.ok();
    });
}

/// A title Worker that never finishes is killed at the timeout and the
/// placeholder is kept — no hang, no leaked child. The `create` response returns
/// immediately (the titler is detached), so the TEST itself completes fast even
/// though the titler waits out its (low, env-set) timeout against a hung Worker.
#[test]
fn timeout_keeps_placeholder() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    seed_codex_credential(&creds_dir);

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TITLE_WORKER_CMD", fixture_cmd("title-worker.ts", &[]))
        // The title Worker emits one partial delta then blocks forever.
        .env("INKSTONE_TITLE_FIXTURE_HANG", "1")
        // A short timeout so the titler gives up well within the test's wait.
        .env("INKSTONE_TITLE_TIMEOUT_MS", "200")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let prompt = "reconcile the vendor invoices";
        let thread_id = create_thread(&mut ws, 1, prompt).await;

        // Wait comfortably past the 200ms timeout. If the titler hadn't been
        // time-bound, it would wait on the hung Worker forever; the title would
        // still read as the placeholder (a hung Worker never updates), so the
        // env seam + timeout fn (`title_timeout`) — exercised by the unit test —
        // are what make the behavior, and the RED→GREEN, meaningful.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        let title = title_of(&mut ws, 100, &thread_id)
            .await
            .expect("created thread is in the feed");
        assert_eq!(
            title, prompt,
            "titler timed out, kept the placeholder (never sanitized the partial output)"
        );

        ws.close(None).await.ok();
    });
}

/// With no credential the run-creation provider gate (ADR-0062) rejects
/// `thread/create` up front with `-32004` — no Thread is minted, no Run, no titler.
/// (This supersedes the old "create succeeds, placeholder stays" behavior: a
/// thread create IS a run start, so a disconnected provider fails it loud rather
/// than birthing a thread whose Run will only 401.)
#[test]
fn no_credential_rejects_thread_create() {
    let workspace = Workspace::new();
    // Point the credentials dir at an empty (existing) dir so `read` → None and
    // the run-creation gate rejects before any Thread/Run is written.
    let creds_dir = workspace.path().join("credentials");
    std::fs::create_dir_all(&creds_dir).expect("create empty credentials dir");

    // No worker/titler fixtures needed: thread/create is rejected up front, so
    // neither the Run's Worker nor the titler ever spawns.
    let core = workspace
        .core()
        .no_seeded_credential()
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        // thread/create is rejected with -32004 (provider not connected); no thread
        // is minted, so thread/list stays empty.
        let create = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "thread/create",
            "params": { "prompt": "summarize the launch retro" },
        })
        .to_string();
        ws.send(Message::Text(create.into()))
            .await
            .expect("send thread/create frame");
        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("create response is JSON: {e} — body: {body}"));
        assert_eq!(
            v["error"]["code"].as_i64(),
            Some(-32004),
            "thread/create with no credential is rejected as provider-not-connected — body: {body}"
        );
        assert!(
            v.get("result").is_none(),
            "a rejected create returns no result — body: {body}"
        );

        // Nothing was persisted: the thread feed is empty.
        let list = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "thread/list",
            "params": {},
        })
        .to_string();
        ws.send(Message::Text(list.into()))
            .await
            .expect("send thread/list frame");
        let body = next_text(&mut ws).await;
        let v: serde_json::Value = serde_json::from_str(&body)
            .unwrap_or_else(|e| panic!("list response is JSON: {e} — body: {body}"));
        assert_eq!(
            v["result"]["threads"].as_array().map(Vec::len),
            Some(0),
            "no Thread was minted by the rejected create — body: {body}"
        );

        ws.close(None).await.ok();
    });
}

/// A successful generation pushes a `thread/titled` notification onto the
/// creating connection (ADR-0047): the SAME socket that sent `thread/create`
/// receives an unsolicited `{thread_id, title}` frame carrying the SANITIZED
/// title — no `thread/list` poll required. Proves the live
/// create→titler→sanitize→push wiring end to end.
#[test]
fn generated_title_pushes_notification() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    seed_codex_credential(&creds_dir);

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TITLE_WORKER_CMD", fixture_cmd("title-worker.ts", &[]))
        // The SAME dirty output the lazy test uses: asserting the sanitized
        // `title` in the pushed frame proves the push rides AFTER sanitize, not
        // the raw blob.
        .env(
            "INKSTONE_TITLE_FIXTURE_OUTPUT",
            "<think>the user wants a budget plan</think>\n\"Budget planning for Q3\"",
        )
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let prompt = "i need to plan the q3 budget across all teams and figure out headcount";
        let thread_id = create_thread(&mut ws, 1, prompt).await;

        // On the SAME socket, read past any interleaved frames until the live
        // push arrives (bounded, so a missing push fails fast).
        let params = read_until_method(&mut ws, "thread/titled", Duration::from_secs(2))
            .await
            .expect("a thread/titled notification was pushed on the creating connection");
        assert_eq!(
            params["thread_id"].as_str(),
            Some(thread_id.as_str()),
            "push names the created thread"
        );
        assert_eq!(
            params["title"].as_str(),
            Some("Budget planning for Q3"),
            "pushed title is the SANITIZED generated title"
        );

        ws.close(None).await.ok();
    });
}

/// Silent-on-failure (ADR-0047): when the generation sanitizes to None
/// (`INKSTONE_TITLE_FIXTURE_EMPTY`), the title is never written, so NO
/// `thread/titled` frame is pushed — the placeholder stays and the channel stays
/// quiet. A bounded read asserts the absence.
#[test]
fn empty_generation_pushes_no_notification() {
    let workspace = Workspace::new();
    let creds_dir = workspace.path().join("credentials");
    seed_codex_credential(&creds_dir);

    let core = workspace
        .core()
        .no_seeded_credential()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TITLE_WORKER_CMD", fixture_cmd("title-worker.ts", &[]))
        .env("INKSTONE_TITLE_FIXTURE_EMPTY", "1")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let prompt = "draft the offsite agenda";
        let _thread_id = create_thread(&mut ws, 1, prompt).await;

        // Give the titler ample time to run and sanitize to None, watching the
        // socket the whole time: no `thread/titled` frame must ever arrive.
        let pushed = read_until_method(&mut ws, "thread/titled", Duration::from_millis(600)).await;
        assert!(
            pushed.is_none(),
            "empty-after-sanitize generation pushes no thread/titled frame — got {pushed:?}"
        );

        ws.close(None).await.ok();
    });
}
