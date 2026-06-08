# Worker-side transport is a code-level seam: a `WorkerTransport` the interpreter depends on

The Worker's generic interpreter ([ADR-0018](./0018-workflow-and-tools-definition.md)) talks to its stdio through a **`WorkerTransport`** — a small Effect service (`Context.Tag`) with the operations the interpreter needs: read the manifest once at startup, emit a Run Event, and round-trip a Tool Request to Core. The interpreter (`runInterpreter`) **depends on the service** and owns all run-driving logic (manifest→pi mapping, event translation, the terminal-event guarantee); the stdio plumbing moves behind the seam. Two adapters satisfy it as `Layer`s: a production **`StdioTransportLive`** (the sole module touching `process.stdin`/`process.stdout`, owning NDJSON framing, the manifest read, and the `tool_call_id` correlation map) and a test-only **`InMemoryTransport`** (preset manifest, captured Run Events, a scripted tool-result table). `main` becomes `Effect.gen` from entry to exit, provides the production `Layer`, and runs the interpreter. This is the Worker-side mirror of [ADR-0026](./0026-worker-transport-seam.md): that ADR put **Core's** end of the stdio pipe behind a seam; this puts the **Worker's** end behind one.

## What this means concretely

- **`packages/worker/src/cli.ts` stops being where transport lives.** It splits into: `transport.ts` (the `WorkerTransport` `Context.Tag` + its method types — the interface), `transport-stdio.ts` (`StdioTransportLive`, the sole `process.stdin`/`stdout` site, owning readline, the `pendingTools` correlation `Map`, and the stdout writer), and a thin `main` that reads the manifest, builds provider deps, provides `StdioTransportLive`, and runs `runInterpreter`. `InMemoryTransport` lives with the tests.
- **The interpreter loses its loose `emit`/`callTool` params** ([interpreter.ts](../../packages/worker/src/interpreter.ts) today threads them through `InterpreterDeps`) and instead requires `WorkerTransport` from context. Provider deps (`resolveModel`, `streamFn`) stay injected — they're a *different* seam (the provider seam, [ADR-0023](./0023-provider-oauth-core-owned-credentials.md)).
- **The interpreter's logic is unit-testable in-process** by providing `InMemoryTransport`: no spawned process, no readline, no stdout capture. The captured-events array and the scripted tool-result table *are* the assertions. The existing `interpreter.test.ts` / `tool-proxy.test.ts` migrate from hand-injected functions to the test `Layer`.
- **The three e2e fixture workers** (`crates/core/tests/fixtures/{tool,propose,slow}-worker.ts`) reuse `StdioTransportLive` instead of each re-rolling readline + JSON `emit`. They keep only their canned provider script.
- **Nothing on the wire changes.** `RunEvent`, the `tool_request`/`tool_result` frames, and `WorkerManifest` ([ADR-0009](./0009-protocol-strategy.md) hand-mirrored types) are reused verbatim; the seam speaks those existing types.

## Why a code-level seam (the env var is not enough)

`INKSTONE_WORKER_CMD` swaps which Worker executable Core launches — a process-level seam that serves real-process integration tests and stays. It cannot make the interpreter's logic — manifest mapping, event translation, the tool round-trip, the terminal-event guarantee — reachable without spawning a `tsx` process and racing its stdio. Today `cli.ts` has **zero** unit tests for exactly this reason, and the three fixture workers prove the absence of a seam by each re-implementing the framing `cli.ts` owns. A code-level `WorkerTransport` lets a test feed the interpreter a preset manifest and a scripted tool-result table and assert on the captured Run Events in milliseconds.

## Why one transport with two methods, not two seams

[ADR-0006](./0006-run-events-vs-tool-protocol.md) requires Run Events (one-way, fire-and-forget) and the Tool Protocol (bidirectional, blocks the Run) to be treated as **separate concepts** in code. `emit` and `callTool` are two distinct methods with the two different shapes — that *is* treating them as separate concepts. ADR-0006 asks for separate concepts, not separate objects. Splitting into a `RunEventSink` tag and a `ToolChannel` tag was considered (it would fully isolate the correlation state and let a chat-only Workflow depend on nothing tool-related) and rejected: two `Context.Tag`s plus a shared lower-level stdout writer is machinery a single interpreter consumer doesn't earn. The Rust side agrees — [ADR-0026](./0026-worker-transport-seam.md)'s `WorkerPort` is one transport, and the one-way/bidirectional split happens by matching `WorkerStdout` inside the loop. Revisit only if a second consumer wants just the Run Event side.

## Why an Effect `Layer`, not a plain injected object

A plain interface object passed to `runInterpreter` (the way `callTool` is injected today) would be a smaller diff and keep `interpreter.ts` on async/await. It was rejected because [ADR-0020](./0020-effect-across-typescript.md) commits the Worker to `Effect.gen` from entry to exit, and `cli.ts` is currently the one TypeScript module that violates that — raw promises, a module-scope mutable `Map`, callback `process.stdout.write`. A `Context.Tag` provided by a `Layer` is the DI mechanism that ADR already prescribes for "Test Harness fakes," and it matches the `WsClient` seam in `packages/ui-sdk` — the in-repo template for a clean Effect seam. Putting transport behind a `Layer` closes the ADR-0020 gap as a side effect of cutting the seam.

This deviates from [ADR-0026](./0026-worker-transport-seam.md) on purpose. Core's `run_loop<P: WorkerPort>` chose **static generic dispatch** (no `dyn`, chosen at the call site) over runtime DI, because Rust monomorphizes it at zero cost. The TypeScript analog of "static" would be the plain object; the analog of "service injection" is the `Layer`. ADR-0020 makes `Layer`-based injection the TypeScript idiom, so the two sides land on different DI mechanisms for the same seam — each idiomatic for its language.

## The shape asymmetry: push, not pull

[ADR-0026](./0026-worker-transport-seam.md)'s `WorkerPort` is a **pull** interface: Core's loop calls `recv()` when it decides to read the next frame. `WorkerTransport` cannot mirror that, because the Worker does not own its loop — `pi-agent-core`'s `runAgentLoop` does, and it calls outward (a sync `onEvent` sink and a `Promise`-returning tool `execute`). So the seam is **push + request/response**: `emit(event)` is fire-and-forget, `callTool(req)` awaits a response, and there is no `recv()`. A reader expecting a literal `WorkerPort` reflection will be surprised; the leverage is identical (deep module, real seam, in-process tests, no duplicated framing) but the shape is dictated by who owns the loop.

A consequence of running the interpreter inside `Effect.gen` while `pi-agent-core` drives with plain callbacks: the adapters bridge Effect↔callback by running the `emit`/`callTool` Effects on the runtime from inside `pi-agent-core`'s callbacks. This is the "Effect↔world friction" ADR-0020 names; it concentrates in `StdioTransportLive`, not in the interpreter.

## Scope: transport seam only

This change builds the seam and converts `main` to `Effect.gen`. It does **not** evict the five `INKSTONE_FAUX_*` branches in `depsFor` — those script the faux *provider* (the provider seam), not transport, and [ADR-0019](./0019-test-harness-architecture.md) wants that scripting driven from the manifest/fixture rather than runtime env flags in the shipping bundle. That eviction is a named follow-up, deliberately deferred to keep this change surgical (one seam at a time). The ADR-0019 gap — runtime-env-gated test code in the production entry point — remains open until then.

## Considered and rejected

- **Keep `cli.ts` as-is (process-level seam only).** Rejected: leaves the interpreter's logic reachable only by spawning a real `tsx` process — the status quo this ADR exists to fix (zero unit tests on the entry point; three fixtures re-rolling framing; test branches in the shipping bundle).
- **Plain injected object instead of a `Layer`.** Smaller diff, but violates ADR-0020's Effect-entry-to-exit commitment and leaves `cli.ts` the one non-Effect TypeScript module. Rejected.
- **Split into `RunEventSink` + `ToolChannel`.** The most literal reading of ADR-0006; isolates correlation state; lets a chat-only Workflow depend only on the Run Event side. Rejected as machinery a single interpreter consumer doesn't earn — two methods on one tag already honor the separate-concepts rule. Revisit if a second consumer appears.
- **A literal `WorkerPort` `recv()` mirror.** Impossible without inverting `pi-agent-core`'s ownership of the loop. The Worker is driven, so the seam is push + request/response.
- **Evict `depsFor` in the same change.** Closes the ADR-0019 gap but conflates a provider-seam refactor with the transport seam. Deferred to a follow-up.

## How this refines earlier ADRs

- **[ADR-0026](./0026-worker-transport-seam.md):** the Worker-side counterpart. 0026 put Core's end of the stdio pipe behind `WorkerPort` (pull); this puts the Worker's end behind `WorkerTransport` (push). Opposite ends of the same pipe, same seam idea, mirror-image shape and a different DI mechanism (generic dispatch vs `Layer`).
- **[ADR-0006](./0006-run-events-vs-tool-protocol.md):** `emit` (Run Events) and `callTool` (Tool Protocol) are the two logical channels, kept as separate concepts via two methods on the one transport.
- **[ADR-0013](./0013-worker-process-lifecycle-and-transport.md):** unchanged in substance — manifest-first stdin, kept-open stdin for `tool_result` writes, stdout NDJSON. This pins how the Worker expresses that transport in code: behind `WorkerTransport`, with `StdioTransportLive` the sole `process.stdin`/`stdout` site.
- **[ADR-0018](./0018-workflow-and-tools-definition.md):** the generic interpreter stays the deep module; it now requires `WorkerTransport` from context instead of taking loose `emit`/`callTool` parameters.
- **[ADR-0019](./0019-test-harness-architecture.md):** faux provider scripting via `depsFor`'s env branches stays for now; moving it out of the shipping bundle is a named follow-up, not done here.
- **[ADR-0020](./0020-effect-across-typescript.md):** `main` becomes `Effect.gen` entry-to-exit and the transport is a `Context.Tag` provided by a `Layer`, matching `ui-sdk`'s `WsClient`. Closes the gap where `cli.ts` was the one TypeScript module on raw promises and callbacks.

## Related

- [ADR-0026](./0026-worker-transport-seam.md) — the Core-side seam this mirrors.
- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — the Run Event / Tool Protocol split the two methods honor.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — the stdio transport this expresses in code.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — the generic interpreter that depends on the seam.
- [ADR-0019](./0019-test-harness-architecture.md) — the `depsFor` eviction left as a follow-up.
- [ADR-0020](./0020-effect-across-typescript.md) — the Effect `Layer` idiom this adopts for the seam.
