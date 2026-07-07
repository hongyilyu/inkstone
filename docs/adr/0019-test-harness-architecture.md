# Test Harness architecture: end-to-end via spawned Core, headless browser, mock LLM in Worker

End-to-end tests run against a real Core process, a real Worker process when one is needed, and a real Web Client in a headless browser. The Test Harness package (`tests/`) drives them. LLM calls are intercepted at the Worker's provider seam by pi-ai's `faux` provider, scripted from a test-only Worker entry (the original draft's "mock compiled into the Worker" — see the as-built amendments below); no test ever touches a real provider.

This ADR records the architecture so that test-authoring decisions over the next year don't relitigate the same questions.

## As-built amendment (e2e-harness flow)

The harness was implemented after the Web Client was wired to real Core (the `wire-web-client` feature). Three decisions in the original draft were adjusted to the smallest change that delivered the headline acceptance tests; the rest of the ADR stands as written.

- **Config surface is `INKSTONE_*` env overrides, not CLI flags.** Core is configured by environment variables — `INKSTONE_PORT` (default `8765`; `0` = OS-assigned ephemeral), `INKSTONE_WEB_DIR` (debug-only SPA-from-disk serving), `INKSTONE_DB_PATH` (per-test Workspace). This matches Core's existing `INKSTONE_DB_PATH` / `INKSTONE_WORKER_CMD` convention; a real argument parser (and a literal `--web-dir` / `--port` flag) is deferred to a product CLI feature. Where this ADR says `--web-dir=<dist>`, read `INKSTONE_WEB_DIR=<dist>`; the debug-build gate is preserved (a release binary ignores the env var, so production cannot serve arbitrary files from disk).
- **Echo-era determinism rides the slow-worker gate fixture, not a compiled-in mock LLM.** The Worker mock-LLM provider described below is deferred until the first real-LLM Workflow exists (there is nothing for it to stand in for in the echo product). Until then, determinism comes from `crates/core/tests/fixtures/slow-worker.ts`, selected via `INKSTONE_WORKER_CMD` with `INKSTONE_FIXTURE_CHUNKS` / `INKSTONE_FIXTURE_GATE`. It speaks the real Worker NDJSON protocol and is spawned by Core exactly as the real Worker would be, so the "only Core spawns Worker" invariant (ADR-0001/0013) holds. The fixture's gate file is the pause primitive the original draft noted was missing — it lets a test hold a Run provably mid-stream with no wall-clock sleeps, which is what makes the reload-mid-stream and cancellation-style flows deterministic.
- **The Core-served SPA dials a same-origin WebSocket.** Because Core serves the bundle on an ephemeral port, the Web Client derives its WS URL from `window.location` (`ws(s)://<host>/ws`) rather than a hardcoded port. In Vite dev the page's `/ws` is proxied to Core (ADR-0015). The harness relies on this so a Core-served SPA always reaches the Core that served it.

The harness package lives at `tests/e2e/` (registered in `pnpm-workspace.yaml`; root `pnpm test:e2e` delegates to it). Fixtures expose `{core, workspace, chat}` where `chat` is the `ChatPage` page object; the `workspace` fixture exposes `path` only (WS-level setup helpers are deferred — the current specs drive through the UI).

`apps/web/test/test-utils/renderWithCore.tsx` and `rows.ts` provide a deep test-data-builder library and a single-entry render harness for Web Client view tests (the foreseen follow-up to the "Test-data-builder library" bullet under "What this does not decide"); page objects extend to LibraryPage, GtdPage, and SettingsPage under `tests/e2e/src/page-objects/`.

## As-built amendment: `faux` realizes the deferred mock-LLM seam (ADR-0023 feature)

The "Mock LLM provider compiled into Worker" decision below is now realized — not by a bespoke compiled-in mock, but by **`pi-ai`'s built-in `faux` provider**. When the generic interpreter replaced the echo Worker, the Worker gained a real provider-routing layer (`streamSimple` dispatched by `model.api`). `faux` is a first-class provider in that layer, so a Workflow with `provider = "faux"` drives the entire interpreter path — manifest parsing, message mapping, the `pi-agent-core` loop, Run Event emission — with zero network and deterministic output. This is strictly better than a hand-rolled mock: it exercises the *real* `pi-agent-core` loop and the *real* provider seam, not a stand-in for them.

Consequences for this ADR's original mock plan:
- The fixture format (ordered Turn responses keyed by `turn`) and the `INKSTONE_LLM_PROVIDER=mock` / `INKSTONE_LLM_FIXTURE` env contract are superseded by selecting `provider = "faux"` in the Workflow and supplying the faux script's response via the manifest/fixture. The intent ("no test touches a real provider", "fixtures are explicit and human-authored") is preserved.
- Offline determinism for the real-interpreter slices comes from `faux`. The `slow-worker.ts` gate fixture remains for the Core-level mid-stream/pause flows that predate the interpreter.
- The real `openai-codex` provider is exercised only by **manual smoke** (a real ChatGPT login + completion), never in the automated suite — consistent with "no test ever touches a real provider."

## As-built amendment: faux scripting lives in a test-only Worker entry, not the shipping path

The faux script selection above (`INKSTONE_FAUX_*` env branches) originally lived in `depsFor` inside the **production** Worker entry `packages/worker/src/cli.ts` — runtime-env-gated test code in the shipping bundle, the open gap [ADR-0027](./0027-worker-interpreter-transport-seam.md) named and deferred. It is now evicted:

- **`cli.ts` is production-only:** read the manifest, build `defaultInterpreterDeps()`, run the interpreter. No faux imports, no `INKSTONE_FAUX_*` reads.
- **A test-only entry `packages/worker/src/faux/faux-worker.ts`** owns the faux scripting (the five modes, reading `INKSTONE_FAUX_*` — legitimate, because it *is* test code now). Both entries call a shared `runWorkerMain(buildDeps)` that holds the manifest read and the terminal-event guarantee, so the faux entry still drives the **real** `pi-agent-core` interpreter — the whole point of the faux seam (it is not a stand-in for the loop).

  _As-built (relocated):_ the faux entry, its `faux-decisions.ts` helper, and its test moved from top-level `src/` into a dedicated **`src/faux/`** subdirectory, so top-level `src/*.ts` is unambiguously the Worker deep core and `src/faux/` is unambiguously the test mock. The relocation keeps imports relative (faux reaches the deep core via `../interpreter.js` etc.) and adds **no** public exports to `@inkstone/worker` — the package interface stays as small as before. Core and the e2e harness spawn it by the updated path (`INKSTONE_WORKER_CMD` → `tsx .../src/faux/faux-worker.ts`); `cli.guard.test.ts` still keeps the production `cli.ts` faux-free.
- **Selection is by `INKSTONE_WORKER_CMD`:** Core spawns whichever entry a test points at (`faux-worker.ts` for faux runs, `cli.ts` in production). "Only Core spawns Worker" (ADR-0001/0013) is unchanged.

**Why a test-only entry, not a manifest `faux_script` field.** Carrying the script on `WorkerManifest` was considered and rejected: it would put test-only data on the **production wire protocol** (`packages/protocol`), violating "test stays at test." A dedicated entry keeps every byte of faux scripting in test territory while leaving the protocol and Core untouched. So the faux *script* does not ride "the manifest" (as the amendment above loosely allowed) — it rides the test-only entry; the manifest still carries `provider = "faux"` so pi-ai resolves the faux provider, and `faux-worker.ts` reads the script from `INKSTONE_FAUX_*`.

## Core decisions

- **Top-level `tests/` package**, registered in `pnpm-workspace.yaml`. Runs under Playwright's test runner with a `test:e2e` script. Not under `apps/` (it's not a product Client) and not under `packages/` (it's not a library). It's a `Test Harness` per the term in `CONTEXT.md`. It lives at `tests/e2e`, alongside `tests/contract` (per [ADR-0008](./0008-monorepo-shape.md)): `tests/contract` holds protocol-level contract tests — Rust↔TS serialization round-trips, schema parity, one shape per test, no spawned processes. `tests/e2e` holds full-system behavioral tests through the Web Client. If a test could pass without rendering DOM, it belongs in `tests/contract`.
- **Per-test fresh Core, parallel across Playwright workers.** Playwright fixtures are `test`-scoped: each test creates a tempdir Workspace, spawns Core with `--workspace=$tempdir --port=0`, and tears down on exit. The wall-clock cost (~hundreds of ms in debug mode) is hidden by Playwright's worker parallelism, not amortized. Core was designed for one Workspace per process; tests respect that.
- **Core advertises its URL on stdout.** On startup, before accepting connections, Core writes a single line announcing its listening URL. The harness reads stdout until it sees that line. Picking `--port=0` avoids port collisions across parallel tests; safe because [ADR-0007](./0007-local-first-single-user.md) binds Core to loopback.
- **Headless Chromium via Playwright.** Tests assert through the same surface a real user touches. The harness loads Core's URL in Playwright; the Web bundle is served from Core (per [ADR-0015](./0015-web-client-packaging.md)).
- **Core has a debug-only SPA-from-disk override** (`INKSTONE_WEB_DIR=<dist>`; the original draft's `--web-dir=<dist>` flag, realized as an env override per the as-built amendment above). When set, Core serves the SPA from that directory instead of the embedded bundle. The harness builds `apps/web/dist/` (cheap, Vite is fast) and points Core at it; production binaries still embed the SPA. The override is compile-time gated to debug builds (`crates/core/src/main.rs`) so production cannot accidentally serve from disk.
- **Mock LLM lives in a test-only Worker entry, selected via `INKSTONE_WORKER_CMD`.** As built (see the faux amendments above), the original "mock compiled into Worker by dead-code-elimination" was superseded: determinism comes from pi-ai's built-in `faux` provider, scripted by a test-only entry `packages/worker/src/faux/faux-worker.ts` that reads `INKSTONE_FAUX_*` env vars and drives the *real* `pi-agent-core` interpreter. The production entry `packages/worker/src/cli.ts` carries no faux code; both share `runWorkerMain` (`packages/worker/src/worker-main.ts`). Core spawns whichever entry a test points at via `INKSTONE_WORKER_CMD` and forwards the `INKSTONE_FAUX_*` vars when spawning Worker. Tests never load a Worker module directly — preserving the "Core spawns Worker" invariant from [ADR-0001](./0001-core-worker-split.md) and [ADR-0013](./0013-worker-process-lifecycle-and-transport.md).
- **Fixture format: faux script via `INKSTONE_FAUX_*`, not the original `{turn, response}` JSON.** The original draft's ordered-by-`turn` JSON fixture and `INKSTONE_LLM_FIXTURE` contract were superseded by the faux seam (see amendments): each faux mode (response, tool-call, propose, extract, capture, …) is driven by an `INKSTONE_FAUX_*` env var, with scenario JSON supplied via `*_PARAMS` files for the richer modes. Determinism for the Core-level mid-stream/pause flows that predate the interpreter still rides `crates/core/tests/fixtures/slow-worker.ts` (`INKSTONE_FIXTURE_CHUNKS` / `INKSTONE_FIXTURE_GATE`). Tests that don't trigger a Run set no faux var, so any stray Run falls through to the default reply harmlessly.
- **Mock validates nothing about message history.** A fixture that returns "the file said hello" when the Worker actually got a tool error will pass at the mock layer and fail at the assertion layer — by design. Tests assert observable user-visible behavior; the mock is a stand-in for the LLM, not a contract for "what the Worker should have done." Tests that want belt-and-braces verification that the mock was used (rather than a real provider) assert that the first response matches fixture entry 0.
- **Worker stderr teed through Core stderr in debug mode** so the harness captures Worker exceptions and logs through one stream.
- **Playwright fixtures expose `{core, workspace, page}`.** `core` is the spawned-process handle. `page` is Playwright's. `workspace` exposes typed setup helpers (`createThread`, `postMessage`, `path`, `withFixture`, etc.) implemented as a thin wrapper around the same WebSocket protocol the Web Client uses (per [ADR-0014](./0014-client-core-wire-protocol.md)) — same surface, different caller. A page-object layer hides DOM selectors so test code is behavior-level, not DOM-level.
- **Spawned Core runs in its own process group**, hard-killed on a deadline if SIGTERM hangs. Tempdirs use a recognizable prefix (`inkstone-test-*`) and are cleaned in per-test teardown plus a session-end exit handler.

## Scope: full-system tests only

This ADR governs *full-system* end-to-end tests — those that exercise Core + Worker + UI together. Tests against a Web Client running on **mock data only** (no Core, no Worker, no protocol traffic) live next to the Client they test, currently `apps/web`, under that package's `e2e/` directory and its own `test:e2e` script. Such tests are useful for catching layout / component-composition regressions that jsdom Vitest can't see; they are not full-system tests and the `tests/` harness, the `INKSTONE_WEB_DIR` SPA-from-disk override, the faux Worker provider, and the spawned-Core fixture all do not apply. When the Web Client is wired to real Core (the future re-wiring feature), full-system tests of those flows belong in `tests/` per the rest of this ADR; the `apps/web` mock-driven e2e suite stays as the no-network smoke surface.

## What this does not decide

- **CI integration.** Local-first test runs are the bar; GitHub Actions or similar is a follow-up.
- **Cassette-based recording, programmatic fixtures, prompt-hash matching.** All considered and rejected for MVP — fixtures are explicit ordered Turn responses, hand-authored.
- **Cross-Client harness reuse.** TUI / capture clients aren't in scope; the harness is Web-only.
- **Performance-test infrastructure.** Out of scope.
- **Test-data-builder library.** Tests assemble their own state through `workspace` helpers; no shared builders until duplication justifies it.
- **Cancellation e2e.** The cancellation contract per [ADR-0014](./0014-client-core-wire-protocol.md) is exercised in Core unit tests for MVP; e2e cancellation tests would need a fixture-side pause primitive that doesn't exist yet.
- **Multi-tab consistency e2e.** Tested at the Core unit-test level (mutation-event broadcast to multiple WS clients); harness stays single-page.

## Why mock the LLM in Worker, not the harness

Two alternatives were considered:

- **Mock in harness.** Worker would dynamically import a provider module from a path passed via env. Cleaner separation in theory, but requires Worker to have a "load arbitrary module from path" seam, which is an attack surface even in test mode and complicates the Worker's bundle/build story.
- **Cassettes (record/replay).** Wraps the HTTP layer to record real provider calls on first run and replay thereafter. Closest to reality (real wire bytes) but flaky: prompt drift breaks fixtures silently, recording requires API keys, and recordings rot without anyone noticing.

The chosen path — Worker-owned mock with file-based fixtures — keeps the security surface of Worker constant (no dynamic loading), keeps fixtures human-authorable and reviewable, and makes test failures deterministic. Build-mode exclusion (rather than runtime env-var gating) keeps the production bundle free of test-only code paths. Trade-off: tests don't exercise the *real* wire format. That's acceptable because the wire format is owned by the LLM SDK, which the project doesn't control anyway.

## Why per-test fresh Core, not shared Core

Core was designed for one Workspace per process (per `CONTEXT.md`'s `Workspace` term and ADR-0007). A "multi-workspace mode just for tests" would force a product complication for testing convenience. The cost of fresh-Core-per-test is spawn latency (~hundreds of ms in debug mode); acceptable in exchange for true isolation, hidden in wall-clock time by Playwright's worker parallelism.

## Why Playwright over wire-level WS clients

A wire-level test (open the WebSocket, send `session/hello`, drive flows by JSON-RPC) would be faster and more deterministic. It would *not* prove that the rendered DOM behaves correctly — selectors, focus, accessibility, hydration. The MVP-scope features (chat-driven Web Client per [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md)) are UI-shaped; testing them at the wire level would miss the surface that breaks. Playwright is the cost paid for catching UI regressions.

When wire-level tests become useful (e.g., for protocol contract tests independent of UI), they live in `tests/contract`, not in `tests/e2e`.

## Considered and rejected

- **Vitest as the harness runner instead of Playwright.** Vitest doesn't drive browsers; would need Playwright as a dependency anyway. Splitting harness-orchestration (Vitest) from browser-driving (Playwright) introduces two test runners. Use Playwright's runner end-to-end.
- **Apps/web as the test-author home.** Tests would be web-flavored and couple to one Client. The harness shouldn't belong to a Client it's testing.
- **Real LLM provider with tight rate limits.** Most realistic; slowest, costs money, non-deterministic. Inappropriate for a dev-loop harness.
- **One Core process for all tests, opening/closing Workspaces.** Forces Core to learn multi-workspace semantics, which it would never need in production. Invents complexity for the wrong actor.
- **Programmatic fixtures (TS function returning provider response from `(turn, history)`).** Maximum flexibility, but fixtures become code — harder to author, review, diff, and rotate.
- **Mock provider always shipped, runtime env-var gated.** Simpler one-config build, but production bundle carries test-only code reachable by setting one env var. Build-mode exclusion is one extra conditional for an unambiguous shipping story.
- **Always rebuild Core for FE changes (no SPA-from-disk override).** Honors "production-style serving" most strictly, but pays a Rust compile cost on every FE-only iteration. The debug-only `INKSTONE_WEB_DIR` override serves files from disk — a strict subset of what `rust-embed` does in prod, no new attack surface.
- **Mock-driven UI tests in `tests/` instead of `apps/web/e2e/`.** Considered. Mock-driven tests don't need a spawned Core, a mock Worker, or fixtures; placing them in `tests/` would require either gutting the spawned-Core fixture for them (forks the harness shape) or paying the spawn cost for tests that ignore it (waste). Co-locating with the Client they test keeps the Client's regression surface inside the Client's `pnpm install` boundary and avoids cross-package script gymnastics.

## Related

- [ADR-0001](./0001-core-worker-split.md) — harness respects: only Core spawns Worker.
- [ADR-0002](./0002-clients-talk-only-to-core.md) — page-object code accesses Core only through the served Web Client; `workspace` helpers go through Core's same client surface.
- [ADR-0008](./0008-monorepo-shape.md) — `tests/` is a top-level monorepo directory holding both `tests/e2e` and `tests/contract`.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — Worker is per-Run, Core-owned, stdio-transported; the mock lives inside it.
- [ADR-0014](./0014-client-core-wire-protocol.md) — Core's HTTP listener serves the Web bundle and the WebSocket on the same port; `workspace` setup helpers ride the same WS.
- [ADR-0015](./0015-web-client-packaging.md) — production embeds the bundle in Core; the harness uses production-style serving via the debug-only `INKSTONE_WEB_DIR` override for fast FE iteration.
