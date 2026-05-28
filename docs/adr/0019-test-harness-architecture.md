# Test Harness architecture: end-to-end via spawned Core, headless browser, mock LLM in Worker

End-to-end tests run against a real Core process, a real Worker process when one is needed, and a real Web Client in a headless browser. The Test Harness package (`tests/`) drives them. LLM calls are intercepted at the Worker's provider seam by a mock that's compiled into the Worker only in test/debug builds; no test ever touches a real provider.

This ADR records the architecture so that test-authoring decisions over the next year don't relitigate the same questions.

## Core decisions

- **Top-level `tests/` package**, registered in `pnpm-workspace.yaml`. Runs under Playwright's test runner with a `test:e2e` script. Not under `apps/` (it's not a product Client) and not under `packages/` (it's not a library). It's a `Test Harness` per the term in `CONTEXT.md`. The boundary with `bridges/` (per [ADR-0008](./0008-monorepo-shape.md)): `bridges/` holds protocol-level contract tests — Rust↔TS serialization round-trips, one shape per test, no spawned processes. `tests/` holds full-system behavioral tests through the Web Client. If a test could pass without rendering DOM, it belongs in `bridges/`.
- **Per-test fresh Core, parallel across Playwright workers.** Playwright fixtures are `test`-scoped: each test creates a tempdir Workspace, spawns Core with `--workspace=$tempdir --port=0`, and tears down on exit. The wall-clock cost (~hundreds of ms in debug mode) is hidden by Playwright's worker parallelism, not amortized. Core was designed for one Workspace per process; tests respect that.
- **Core advertises its URL on stdout.** On startup, before accepting connections, Core writes a single line announcing its listening URL. The harness reads stdout until it sees that line. Picking `--port=0` avoids port collisions across parallel tests; safe because [ADR-0007](./0007-local-first-single-user.md) binds Core to loopback.
- **Headless Chromium via Playwright.** Tests assert through the same surface a real user touches. The harness loads Core's URL in Playwright; the Web bundle is served from Core (per [ADR-0015](./0015-web-client-packaging.md)).
- **Core has a debug-only `--web-dir=<dist>` flag.** When set, Core serves the SPA from that directory instead of the embedded bundle. The harness builds `apps/web/dist/` (cheap, Vite is fast) and points Core at it; production binaries still embed the SPA. The flag is compile-time gated to debug builds so production cannot accidentally serve from disk.
- **Mock LLM provider compiled into Worker in test/debug builds only.** Worker exposes a provider interface; the mock is included by build-mode dead-code-elimination, not by runtime env-var gating. Selection at test time uses `INKSTONE_LLM_PROVIDER=mock` and `INKSTONE_LLM_FIXTURE=<absolute-path>`. The harness sets the env vars when spawning Core; Core forwards them when spawning Worker. Tests never load a Worker module directly — preserving the "Core spawns Worker" invariant from [ADR-0001](./0001-core-worker-split.md) and [ADR-0013](./0013-worker-process-lifecycle-and-transport.md).
- **Fixture format: ordered list of Turn responses, indexed by `turn`.** Each entry is `{turn: N, response: {...}}` — the full provider response (text or tool calls) for that Turn. The mock matches entries by the `turn` field, not by call order; a Run that respawns its Worker (e.g., after a Proposal acceptance per [ADR-0013](./0013-worker-process-lifecycle-and-transport.md)) reuses the same fixture, and the new Worker's first Turn N matches `turn: N`. Running off the end is a test error. Fixtures live next to the tests that use them as JSON files; the harness resolves them to absolute paths before passing to Core. Tests that don't trigger a Run still set the env vars and use an empty fixture `[]` — a stray Run trips the "off the end" error immediately.
- **Mock validates nothing about message history.** A fixture that returns "the file said hello" when the Worker actually got a tool error will pass at the mock layer and fail at the assertion layer — by design. Tests assert observable user-visible behavior; the mock is a stand-in for the LLM, not a contract for "what the Worker should have done." Tests that want belt-and-braces verification that the mock was used (rather than a real provider) assert that the first response matches fixture entry 0.
- **Worker stderr teed through Core stderr in debug mode** so the harness captures Worker exceptions and logs through one stream.
- **Playwright fixtures expose `{core, workspace, page}`.** `core` is the spawned-process handle. `page` is Playwright's. `workspace` exposes typed setup helpers (`createThread`, `postMessage`, `path`, `withFixture`, etc.) implemented as a thin wrapper around the same WebSocket protocol the Web Client uses (per [ADR-0014](./0014-client-core-wire-protocol.md)) — same surface, different caller. Vault file seeding when needed uses direct FS writes, since the Vault is a user-owned directory rather than a Core-internal abstraction. A page-object layer hides DOM selectors so test code is behavior-level, not DOM-level.
- **Spawned Core runs in its own process group**, hard-killed on a deadline if SIGTERM hangs. Tempdirs use a recognizable prefix (`inkstone-test-*`) and are cleaned in per-test teardown plus a session-end exit handler.

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

When wire-level tests become useful (e.g., for protocol contract tests independent of UI), they live in `bridges/`, not in `tests/`.

## Considered and rejected

- **Vitest as the harness runner instead of Playwright.** Vitest doesn't drive browsers; would need Playwright as a dependency anyway. Splitting harness-orchestration (Vitest) from browser-driving (Playwright) introduces two test runners. Use Playwright's runner end-to-end.
- **Apps/web as the test-author home.** Tests would be web-flavored and couple to one Client. The harness shouldn't belong to a Client it's testing.
- **Real LLM provider with tight rate limits.** Most realistic; slowest, costs money, non-deterministic. Inappropriate for a dev-loop harness.
- **One Core process for all tests, opening/closing Workspaces.** Forces Core to learn multi-workspace semantics, which it would never need in production. Invents complexity for the wrong actor.
- **Programmatic fixtures (TS function returning provider response from `(turn, history)`).** Maximum flexibility, but fixtures become code — harder to author, review, diff, and rotate.
- **Mock provider always shipped, runtime env-var gated.** Simpler one-config build, but production bundle carries test-only code reachable by setting one env var. Build-mode exclusion is one extra conditional for an unambiguous shipping story.
- **Always rebuild Core for FE changes (no `--web-dir` flag).** Honors "production-style serving" most strictly, but pays a Rust compile cost on every FE-only iteration. The debug-only flag serves files from disk — a strict subset of what `rust-embed` does in prod, no new attack surface.

## Related

- [ADR-0001](./0001-core-worker-split.md) — harness respects: only Core spawns Worker.
- [ADR-0002](./0002-clients-talk-only-to-core.md) — page-object code accesses Core only through the served Web Client; `workspace` helpers go through Core's same client surface.
- [ADR-0008](./0008-monorepo-shape.md) — `tests/` is a top-level monorepo directory alongside `bridges/`.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — Worker is per-Run, Core-owned, stdio-transported; the mock lives inside it.
- [ADR-0014](./0014-client-core-wire-protocol.md) — Core's HTTP listener serves the Web bundle and the WebSocket on the same port; `workspace` setup helpers ride the same WS.
- [ADR-0015](./0015-web-client-packaging.md) — production embeds the bundle in Core; the harness uses production-style serving via `--web-dir` for fast FE iteration.
