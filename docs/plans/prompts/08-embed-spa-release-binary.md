# Embed the built SPA in the release Core binary (ADR-0015 production path)

## Context

Inkstone is a local-first personal assistant: Rust Core (axum HTTP+WS server over SQLite, `crates/core`), TS Worker, React SPA (`apps/web`, Vite + TanStack Router). Read AGENTS.md (working principles + §6 CI gate) and CONTEXT.md first.

ADR-0015 (`docs/adr/0015-web-client-packaging.md`) decided the production path long ago: `pnpm build` in `apps/web` produces `dist/`, Core embeds those files at compile time via rust-embed, and the shipping artifact is a single binary. Lines 12–21 specify the routing verbatim: `GET /` → embedded `index.html`; `GET /assets/*` → embedded CSS/JS/images; `GET /ws` → WebSocket upgrade; any other path → embedded `index.html` (SPA fallback for TanStack Router deep links like `/threads/abc`). Line 10 carries an as-built note: "the embedded-SPA production path is not yet implemented" — this feature builds it and flips that note.

Current state (all verified at HEAD):
- `crates/core/src/main.rs:102-109` — `match web_dir_for_serving()`: `Some(dir)` wires `ServeDir::new(&dir).fallback(ServeFile::new(index))` as `app.fallback_service(...)` (debug-only INKSTONE_WEB_DIR path, ADR-0019); `None` arm at line 108 is `app.route("/", get(|| async { "Inkstone Core" }))` — the bare liveness string a release binary serves today. Comment block at lines 97–101 describes this.
- `crates/core/src/main.rs:135-142` — `web_dir_for_serving()` returns `None` unconditionally in release (`if !cfg!(debug_assertions) { return None; }`). Must stay byte-identical.
- `rust-embed` has zero matches in `Cargo.toml`, `Cargo.lock`, `crates/core/Cargo.toml` (verified by grep). Current deps at `crates/core/Cargo.toml:6-22` include axum 0.8 (ws), tower-http 0.6 (fs), tokio.
- `apps/web/dist` does not exist in a fresh checkout (`dist` is in `.gitignore`); `pnpm -C apps/web build` (tsc -b && vite build) creates it. `tests/e2e/global-setup.ts:45` runs exactly that and asserts `dist/index.html` exists.
- Tests that pin current behavior (both run under `cargo test` = debug profile, so they stay green untouched): `crates/core/tests/listening.rs:16` asserts `GET /` body == "Inkstone Core"; `crates/core/tests/web_dir.rs` asserts the debug INKSTONE_WEB_DIR path (index, `/assets/app.js`, `/threads/abc` fallback, `/ws` upgrade precedence). `crates/core/tests/ephemeral_port.rs` also GETs `/`. Test harness: `crates/core/tests/common/mod.rs` (`Workspace`/`CoreBuilder` spawn `cargo_bin("core")` with `INKSTONE_PORT=0`, hermetic `INKSTONE_DB_PATH`/`INKSTONE_LOG_DIR`/`INKSTONE_SKILLS_DIR`).
- ADR-0041 (`docs/adr/0041-compiled-worker-binaries.md`) line 48: "The web-bundle embed (ADR-0015) is itself still unbuilt; a unified single-binary bundle is deferred to whenever that lands." and line 66: "ADR-0015 — the single-binary web embed, still unbuilt". Both need flipping.
- ADR-0019 (`docs/adr/0019-test-harness-architecture.md` — note the filename; there is no "local dev loop" ADR-0019) line 44 already describes the end state ("production binaries still embed the SPA") — no change needed there.
- Root `package.json` scripts (lines 6-19): `build:worker`/`build:provider-helper` (bun compile), `dev`, `check`, etc. No release build script exists. `pnpm -C <dir>` style is used by `test:e2e`.
- CI (`.github/workflows/ci.yml`) never runs any release-profile cargo command (verified: `cargo check --locked` + `cargo test --locked` debug only; e2e's globalSetup builds debug Core). So a missing `apps/web/dist` cannot break CI's cargo steps. The e2e job has a "boot-smoke" step pattern (lines ~185-208: `build:worker boot-smoke`, `build:provider-helper boot-smoke`) that compiles a shipping artifact and asserts it boots — the pattern to copy for a release smoke.
- Prototype-verified mechanics (rust-embed 8.11.0 + axum 0.8, same versions as this repo; folder-missing compile error and CARGO_MANIFEST_DIR resolution re-confirmed in the rust-embed-impl 8.11.0 source): (a) the RustEmbed derive fails compile if `folder` is missing — in BOTH profiles when ungated — so the whole module must be `#[cfg(not(debug_assertions))]`; gated that way, debug builds compile fine with no dist present, release fails without it. (b) `folder` relative paths resolve against `CARGO_MANIFEST_DIR` (= `crates/core`), so `"../../apps/web/dist/"` hits the repo-root dist. (c) `f.metadata.mimetype()` requires the `mime-guess` cargo feature. (d) an axum `app.fallback(handler)` after `.route("/ws", ...)` leaves `/ws` untouched and serves `/` → index.html, `/assets/app.js` → `text/javascript`, `/threads/abc` → index.html fallback.

## Goal

Make a release-profile Core binary (`cargo build --release`) serve the built SPA from bytes embedded at compile time, per ADR-0015's routing spec: add `rust-embed` (with `mime-guess`) to `crates/core`, a new `#[cfg(not(debug_assertions))]` module `crates/core/src/web_embed.rs` deriving `RustEmbed` over `../../apps/web/dist/`, and replace only the release side of the `None` match arm in `main.rs` with an embedded-asset fallback handler (SPA fallback to index.html, mimetype from embedded metadata). Add a root `build:release` script that orders the web build before the cargo release build. Debug behavior stays byte-identical: `INKSTONE_WEB_DIR` serving, the bare "Inkstone Core" liveness string, and `web_dir_for_serving()` are untouched. Flip the stale "still unbuilt" notes in ADR-0015 and ADR-0041.

## End state

- `crates/core/Cargo.toml` gains `rust-embed = { version = "8", features = ["mime-guess"] }`; `Cargo.lock` updated and committed (CI uses `--locked`).
- New file `crates/core/src/web_embed.rs`, compiled only in release: `#[derive(RustEmbed)] #[folder = "../../apps/web/dist/"] struct WebAssets;` plus one `pub async fn serve_embedded(uri: Uri) -> Response` handler: trim leading `/`, empty path → `index.html`, `WebAssets::get(path)` else fall back to `WebAssets::get("index.html")`, respond with `header::CONTENT_TYPE` = `file.metadata.mimetype()` and `Body::from(file.data.into_owned())`; 404 only if even index.html is absent (unreachable in a real build). Doc comment cites ADR-0015.
- `crates/core/src/main.rs`: `#[cfg(not(debug_assertions))] mod web_embed;` in the alphabetical mod list (between `mod tools;` at line 25 and `mod worker;` at line 26); the `None` arm (line 108) becomes a block that under `#[cfg(debug_assertions)]` keeps `app.route("/", get(|| async { "Inkstone Core" }))` and under `#[cfg(not(debug_assertions))]` is `app.fallback(web_embed::serve_embedded)`. The `Some(dir)` arm and `web_dir_for_serving()` (lines 135-142) are character-identical to today. Comment block at lines 97-101 updated to describe the release embed.
- Root `package.json` gains `"build:release": "pnpm -C apps/web build && cargo build --release --manifest-path crates/core/Cargo.toml"`.
- Wire behavior of the release binary: `GET /` → embedded index.html (starts `<!doctype html`); `GET /assets/<hashed>.js` → embedded asset with correct content-type; `GET /threads/abc` → index.html (200, not 404); `GET /ws` → WebSocket upgrade unaffected; `INKSTONE_WEB_DIR` still ignored in release.
- Debug binary: byte-identical behavior — `cargo test --manifest-path crates/core/Cargo.toml` passes with zero edits to `listening.rs` / `web_dir.rs` / `ephemeral_port.rs` assertions.
- ADR-0015 line 10 as-built note rewritten to record the path as built; ADR-0041 lines 48 and 66 "still unbuilt" wording flipped. `crates/core/tests/web_dir.rs` header comment (lines 8-9, "Unset (or release) → the bare ... string") corrected to say release serves the embedded SPA (the "never serves arbitrary files from disk" half stays true).

## Desired outcome

Shipping Inkstone becomes "copy one binary, run it, open the browser": a release Core serves the exact SPA it was compiled with, from the same 127.0.0.1 listener that carries the WebSocket. This closes ADR-0015's core promise — version mismatch between client and Core becomes impossible by construction, deep links work (`/threads/abc` returns the SPA shell, not 404), and no dist directory, dev server, or path-resolution guesswork exists at runtime. Until now a release binary answered `GET /` with a bare liveness string, i.e. the product literally had no production UI path.

## Implementation notes

Ordered steps (Effort S — roughly 4 small files touched plus docs):

1. `crates/core/Cargo.toml` — the `[dependencies]` list is alphabetical; insert `rust-embed = { version = "8", features = ["mime-guess"] }` between `axum` (line 8) and `schemars` (line 9). `mime-guess` is required: `EmbeddedFile.metadata.mimetype()` does not exist without it (verified against rust-embed 8.11.0 source — the method is `#[cfg(feature = "mime-guess")]`). Run `cargo check --manifest-path crates/core/Cargo.toml` to refresh `Cargo.lock`; commit the lock (CI runs `cargo check --locked`).

2. Create `crates/core/src/web_embed.rs` (whole file is release-only via the `mod` gate in main.rs — do NOT also gate inside the file). Verified-working shape:
   ```rust
   use axum::body::Body;
   use axum::http::{StatusCode, Uri, header};
   use axum::response::{IntoResponse, Response};
   use rust_embed::RustEmbed;

   #[derive(RustEmbed)]
   #[folder = "../../apps/web/dist/"]
   struct WebAssets;

   pub async fn serve_embedded(uri: Uri) -> Response {
       let path = uri.path().trim_start_matches('/');
       let path = if path.is_empty() { "index.html" } else { path };
       let file = WebAssets::get(path).or_else(|| WebAssets::get("index.html"));
       match file {
           Some(f) => {
               let mime = f.metadata.mimetype().to_string();
               ([(header::CONTENT_TYPE, mime)], Body::from(f.data.into_owned())).into_response()
           }
           None => (StatusCode::NOT_FOUND, "not found").into_response(),
       }
   }
   ```
   `folder` resolves relative to `CARGO_MANIFEST_DIR` (= `crates/core`), so `../../apps/web/dist/` is the repo-root dist — same trick as `workflow.rs::default_dir` (workflow.rs:68-72) and `skills.rs:650`. Write a doc comment in the repo's style citing ADR-0015 (routing spec) and noting the compile-time-folder landmine below.

3. `crates/core/src/main.rs` — two surgical edits:
   - Mod list (lines 1-27, alphabetical): insert `#[cfg(not(debug_assertions))]\nmod web_embed;` between `mod tools;` and `mod worker;`.
   - The `None` arm at line 108. Verified-compiling shape for both profiles:
     ```rust
     None => {
         #[cfg(debug_assertions)]
         let app = app.route("/", get(|| async { "Inkstone Core" }));
         #[cfg(not(debug_assertions))]
         let app = app.fallback(web_embed::serve_embedded);
         app
     }
     ```
     Leave the `Some(dir)` arm and `web_dir_for_serving()` untouched (in release the `Some` arm is unreachable dead code inside a live match — the debug gate is a runtime `cfg!` boolean, so the arm still compiles, clean with zero warnings, verified). Update the comment block at lines 97-101 to say: debug + INKSTONE_WEB_DIR → disk; debug without → liveness string; release → embedded SPA (ADR-0015), env var still ignored.

4. Root `package.json` — add to `scripts` next to `build:worker`/`build:provider-helper`:
   `"build:release": "pnpm -C apps/web build && cargo build --release --manifest-path crates/core/Cargo.toml"`.
   The `pnpm -C` form matches `test:e2e` and `tests/e2e/global-setup.ts:45`. Ordering is the point: the web build must precede the cargo release build because the derive inhales `dist/` at compile time.

5. Docs flips (keep the repo's as-built-amendment style — see ADR-0019, `docs/adr/0019-test-harness-architecture.md`, for tone):
   - `docs/adr/0015-web-client-packaging.md:10` — rewrite the "not yet implemented" as-built note to record it as built (name `crates/core/src/web_embed.rs`, the cfg gate, `mime-guess`, and that `pnpm build:release` is the ordered build; note the "version mismatch impossible by construction" guarantee now holds).
   - `docs/adr/0041-compiled-worker-binaries.md:48` and `:66` — flip "still unbuilt" to built/landed (the unified single-binary bundle deferral wording can stay, just anchored to "now that it exists").
   - `crates/core/tests/web_dir.rs:8-9` — fix the header comment's "Unset (or release) → the bare `"Inkstone Core"` string": release now serves the embedded SPA; the invariant that stays is "release never serves arbitrary files from disk".

Landmines (all verified by prototype against the same crate versions):
- The RustEmbed derive REQUIRES the folder to exist at macro expansion, in ANY profile, when ungated (rust-embed-impl errors with "folder '…' does not exist") — a naive ungated derive breaks plain `cargo check`/`cargo test` (debug) on a fresh checkout because `apps/web/dist` is git-ignored and absent. The module-level `#[cfg(not(debug_assertions))]` gate is the whole protection: debug/CI cargo commands never expand the derive. Do not reach for a `build.rs` that pre-creates the dir — more moving parts, and it would let debug builds silently embed a stale dist (rejected for simplicity, per AGENTS.md §2).
- Consequence of the gate: `web_embed.rs` only typechecks under `--release`. After writing it, verify with `pnpm -C apps/web build && cargo check --release --manifest-path crates/core/Cargo.toml` — plain `pnpm check` will NOT catch errors in this file.
- Any release-profile cargo command (`cargo build/check/test --release`) now fails without `apps/web/dist`. CI is safe (it runs no release cargo today — verified in `.github/workflows/ci.yml`), but say so in the web_embed.rs doc comment so the next person understands the `build:release` ordering.
- rust-embed embeds via `include_bytes!(<canonical path>)` per file, so edits to existing dist files retrigger rustc, but files ADDED to dist after a cargo build may not invalidate the cached derive expansion. `build:release` always runs Vite first (hashed filenames = new files); if a stale embed is ever suspected, `touch crates/core/src/web_embed.rs` forces re-expansion. Worth one line in the doc comment.
- Do not run blanket `cargo fmt` or repo-wide `biome format` (AGENTS.md §6); hand-match existing style.
- Do not touch `crates/core/tests/listening.rs` / `web_dir.rs` / `ephemeral_port.rs` test bodies — they run under debug profile and must pass unchanged (that is the "debug stays byte-identical" proof).

Commit: `feat(core): embed built SPA in release binary (ADR-0015)` — docs flips can ride along or split as `docs(adr): ...`.

## Testing approach

Required, existing gates (AGENTS.md §6 — all must be green):
- `cargo test --manifest-path crates/core/Cargo.toml` — the debug-profile integration suite. `crates/core/tests/listening.rs` (GET / == "Inkstone Core"), `crates/core/tests/web_dir.rs` (INKSTONE_WEB_DIR: index, asset, `/threads/abc` fallback, `/ws` precedence), `crates/core/tests/ephemeral_port.rs` must pass with zero assertion edits — this is the proof debug behavior is untouched.
- `pnpm format`, `pnpm lint`, `pnpm check` (tsc + `cargo check` debug — passes without dist because the module is cfg'd out), `pnpm -r test`.
- `pnpm test:e2e` unaffected (debug Core + `INKSTONE_WEB_DIR`, see `tests/e2e/src/spawnCore.ts:281` and `global-setup.ts:45`) — run it if touching anything near the harness.

Required, new verification for the release path (cfg(not(debug_assertions)) code is invisible to the debug test suite — no cargo test can cover it):
- Typecheck: `pnpm -C apps/web build && cargo check --release --manifest-path crates/core/Cargo.toml`.
- Manual smoke: `pnpm build:release`, then run `target/release/core` with hermetic env (`INKSTONE_PORT=0 INKSTONE_DB_PATH=$(mktemp -d)/db.sqlite INKSTONE_LOG_DIR=$(mktemp -d) INKSTONE_SKILLS_DIR=$(mktemp -d)/skills`), read the announced `INKSTONE_LISTENING http://...` line (main.rs:126), then assert: `curl -fsS $url/` starts `<!doctype html`; `curl -fsS $url/threads/abc` returns the same shell (200); one hashed `GET /assets/*.js` returns `content-type: text/javascript`; `INKSTONE_WEB_DIR=/nonexistent` still boots and serves the embed (env ignored in release).

Recommended (small, follows an existing pattern): add a `build:release boot-smoke` step to the `e2e` job in `.github/workflows/ci.yml`, directly after the two existing boot-smoke steps (`build:worker boot-smoke` / `build:provider-helper boot-smoke`, lines ~185-208 — copy their comment+step shape): run `pnpm build:release`, background `target/release/core` with the hermetic env above and stdout to a mktemp file, poll for `INKSTONE_LISTENING`, curl `/` and `/threads/abc` and grep `<!doctype html`, then kill. This is the ONLY automated gate possible for the release-only code path; without it the embed can rot silently. It shares the job's existing `Swatinem/rust-cache` (`shared-key: core`) — release artifacts land in the same cached `target/`, so the first run pays a full release compile and later runs are incremental. If added, `docs/agents/ci.md` likely needs no edit (it documents jobs, not steps — it never mentions the existing boot-smoke steps either).

## Out of scope

- No compression, cache-control/ETag headers, or pre-compressed assets — ADR-0015 explicitly says Vite's hashed filenames need no extra policy in MVP.
- No change to the debug path: `web_dir_for_serving()`, `INKSTONE_WEB_DIR` semantics, the `Some(dir)` ServeDir arm, and Vite dev proxying stay exactly as-is.
- No `INKSTONE_WEB_DIR` honoring in release (release never serves from disk — that invariant is the point).
- No unified single-binary bundle embedding the worker/provider-helper binaries (ADR-0041 defers it; only its "still unbuilt" wording changes).
- No Tauri/Electron/installer, no cross-OS release matrix, no browser auto-launch (ADR-0015 "What this does not decide").
- No new ADR — ADR-0015 already decided this; only as-built notes flip.
- No Playwright e2e suite against the release binary, no new cargo integration test contorted to build release profile — the CI boot-smoke step (or the manual smoke) is the coverage.
- No `schema_hash` runtime version check (ADR-0014 considered it; the embed makes it unnecessary).
- No refactor of the router construction beyond the single `None` arm.
