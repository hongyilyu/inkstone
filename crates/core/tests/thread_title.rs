//! `thread/create` fires a one-shot, non-Run title Worker (ADR-0046): with a
//! connected provider its sanitized output overwrites `threads.title` (visible
//! via `thread/list`); with no credential, or empty/whitespace output, the
//! prompt-derived placeholder stays.
//!
//! The title Worker is pointed at `title-worker.ts` via
//! `INKSTONE_TITLE_WORKER_CMD`; the Run's own Worker stays on `slow-worker.ts`
//! (via `worker_fixture`) so thread creation still succeeds. A credential is
//! seeded into an `INKSTONE_CREDENTIALS_DIR` so the strict token gate
//! (`Ok(Some)`) is satisfied — the no-credential test omits it.

use std::time::Duration;

use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;

mod common;
use common::{Workspace, fixture_cmd, next_text};

/// Write a non-expired `openai-codex` credential into `dir` so Core's token gate
/// resolves `Ok(Some(_))`. Mirrors `credentials::Credentials`'s on-disk shape.
fn seed_codex_credential(dir: &std::path::Path) {
    std::fs::create_dir_all(dir).expect("create credentials dir");
    let body = r#"{
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

/// Read the current title of `thread_id` via `thread/list`, or `None` if the
/// thread is absent from the feed.
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
    let body = next_text(ws).await;
    let v: serde_json::Value = serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("thread/list response is JSON: {e} — body: {body}"));
    let threads = v["result"]["threads"]
        .as_array()
        .unwrap_or_else(|| panic!("result.threads is an array — body: {body}"));
    threads
        .iter()
        .find(|t| t["id"].as_str() == Some(thread_id))
        .map(|t| {
            t["title"]
                .as_str()
                .unwrap_or_else(|| panic!("thread.title is a string — body: {body}"))
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

        // The initial placeholder is the trimmed prompt (≤ 80 scalars; this one
        // is shorter, so it is the whole prompt).
        let placeholder = title_of(&mut ws, 100, &thread_id)
            .await
            .expect("created thread is in the feed");
        assert_eq!(
            placeholder, prompt,
            "initial title is the prompt-derived placeholder"
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

/// With no credential the strict token gate returns before spawning the titler,
/// so the placeholder stays.
#[test]
fn no_credential_keeps_placeholder() {
    let workspace = Workspace::new();
    // Point the credentials dir at an empty (existing) dir so `read` → None and
    // the token gate returns without spawning the titler.
    let creds_dir = workspace.path().join("credentials");
    std::fs::create_dir_all(&creds_dir).expect("create empty credentials dir");

    let core = workspace
        .core()
        .worker_fixture("slow-worker.ts")
        .env("INKSTONE_CREDENTIALS_DIR", &creds_dir)
        .env("INKSTONE_TITLE_WORKER_CMD", fixture_cmd("title-worker.ts", &[]))
        .env("INKSTONE_TITLE_FIXTURE_OUTPUT", "Should Never Be Applied")
        .spawn();

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime builds");

    rt.block_on(async {
        let mut ws = core.connect().await;

        let prompt = "summarize the launch retro";
        let thread_id = create_thread(&mut ws, 1, prompt).await;

        // No credential → no titler spawn → placeholder is durable. Wait, then
        // assert it never changed.
        tokio::time::sleep(Duration::from_millis(600)).await;
        let title = title_of(&mut ws, 100, &thread_id)
            .await
            .expect("created thread is in the feed");
        assert_eq!(
            title, prompt,
            "no credential → titler never spawns → placeholder kept"
        );

        ws.close(None).await.ok();
    });
}
