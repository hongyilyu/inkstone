# `tests/e2e` — full-system Test Harness

Full-system end-to-end tests (ADR-0019): a real `core` binary, a real Worker
process, and the real Web Client in headless Chromium, driven by Playwright.
No mock data, no in-process stubs — the only substitution is the LLM, which is
stood in for by the deterministic slow-worker gate fixture (there is no real
LLM in the echo-era product yet).

> This is distinct from `apps/web/e2e`, which is a **mock-only** smoke suite
> (static `vite preview`, no Core, no WebSocket). If a test needs Core + Worker
> + UI together, it lives here.

## Run it

```sh
pnpm test:e2e                 # from repo root (delegates to this package)
pnpm test:e2e:install         # one-time: download the Chromium binary
```

`globalSetup` builds the artifacts the harness spawns, once per run:

- `cargo build --manifest-path crates/core/Cargo.toml` → `target/debug/core`
- `pnpm -C apps/web build` → `apps/web/dist`

Both no-op fast when nothing changed, so re-runs don't pay a full rebuild.

To run a single spec or open the trace viewer:

```sh
pnpm -C tests/e2e exec playwright test src/reload-mid-stream.spec.ts
pnpm -C tests/e2e exec playwright test --workers=1
```

## Harness primitives

### `spawnCore(options)` → `{ url, workspaceDir, tripGate, shutdown }`

Spawns one fresh `core` per call. Configuration is via `INKSTONE_*` env
overrides (ADR-0019: env overrides are the MVP config surface; a CLI is a
future product feature):

| Env var | Set by `spawnCore` | Purpose |
|---|---|---|
| `INKSTONE_PORT=0` | always | OS-assigned ephemeral port → no cross-test collisions |
| `INKSTONE_WEB_DIR=<apps/web/dist>` | always | serve the real built SPA (debug-only in Core) |
| `INKSTONE_DB_PATH=<tempdir>/db.sqlite` | always | per-test Workspace isolation |
| `INKSTONE_WORKER_CMD` | default = gate fixture | the Worker Core spawns |
| `INKSTONE_FIXTURE_CHUNKS` / `INKSTONE_FIXTURE_GATE` | when `chunks > 1` | split + pause the stream |

- `url` — `http://127.0.0.1:<port>`, the base for the served SPA and `/ws`.
- `tripGate()` — release the gate file so the fixture streams its remaining
  chunks + `done` (only valid when spawned with `chunks > 1`).
- `shutdown()` — SIGTERM the process group, hard-kill after 5s, remove the
  tempdir. Core runs detached in its own process group so no Worker child is
  orphaned.

### Mock LLM — the gate fixture

There is no compiled-in mock-LLM provider yet (ADR-0019 describes one; it's
deferred to the first real-LLM Workflow). Until then, determinism comes from
`crates/core/tests/fixtures/slow-worker.ts`, pointed at via `INKSTONE_WORKER_CMD`.
It speaks the real Worker NDJSON protocol, so Core spawns it exactly as it would
the real Worker (preserving the "only Core spawns Worker" invariant, ADR-0001).

- `INKSTONE_FIXTURE_CHUNKS=N` splits `echo: <prompt>` into N incremental deltas.
- `INKSTONE_FIXTURE_GATE=<path>` makes the fixture emit chunk 1, then **block**
  until that file exists, then emit the rest. `core.tripGate()` creates the file.

This is what lets a test hold a Run *provably* mid-stream with no wall-clock
sleeps: assert the partial text is visible and the tail is **not**, then trip.

## Page objects

DOM selectors live in `src/page-objects/ChatPage.ts`, never in specs, so specs
read as user flows. Key methods:

- `goto()` — navigate to the served SPA, wait for the composer.
- `send(text)` — type + submit a message.
- `waitForAssistantText(text)` / `expectNoAssistantText(text)` — assert (or
  refute) an assistant bubble's content; the negative form proves the gate holds.
- `newChat()` — clear focus so the next send mints a new thread.
- `openThread(title)` — click a sidebar thread row by title.
- `reload()` — refresh the page (the reload-mid-stream flow).

## Fixtures

`src/fixtures.ts` extends Playwright's `test` with `{ core, workspace, chat }`,
all test-scoped (fresh per test). Per-test Core config is set by tagging:

```ts
import { expect, test } from "./fixtures.js";

test.use({ coreOptions: { chunks: 2 } }); // gated 2-chunk fixture

test("...", async ({ chat, core }) => {
  await chat.goto();
  await chat.send("hello");
  await chat.waitForAssistantText(/echo:/);
  core.tripGate();
  await chat.waitForAssistantText("echo: hello");
});
```

## Canonical example

`src/smoke.spec.ts` is the smallest full-system test: it loads the real SPA
from a real Core and asserts the same-origin WebSocket connected. Start there.
`src/reload-mid-stream.spec.ts` and `src/background-stream.spec.ts` are the two
headline acceptance flows (Core-owned Run durability across a reload, and a Run
advancing while its thread is off-screen).

## Not here (ADR-0019)

- CI integration — local runs are the bar; GitHub Actions is a follow-up.
- WS-level `workspace` setup helpers (`createThread`/`postMessage`) — these
  tests drive through the UI; `workspace` exposes only `path` for now.
- Cancellation and multi-tab e2e — deferred.
