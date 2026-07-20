# worker-transport

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## transport.ts — WorkerTransport

The Worker-side transport seam (ADR-0027): the single service the generic interpreter (ADR-0018) talks to instead of touching `process.stdin`/`stdout` directly. Two `Layer`s satisfy it — a production `StdioTransportLive` and a test-only `InMemoryTransport` — so the interpreter's run-driving logic is unit-testable in-process.

This slice wires both logical channels of ADR-0006:
- `emit` (one-way, fire-and-forget Run Events);
- `callTool` (the bidirectional Tool Protocol: a Tool Request paired with a Tool Result — NEVER fire-and-forget);
- `readManifest` (read + decode the manifest once at startup; ADR-0013).

`emit` is intentionally a SYNCHRONOUS method: it is called from `pi-agent-core`'s synchronous `onEvent` sink, which runs outside the Effect context. `callTool` returns a `Promise` because `pi-agent-core`'s tool `execute` is a `Promise`-returning callback. `readManifest` is an `Effect` because it is awaited once from `main`'s Effect (ADR-0020). The interpreter obtains the transport once at the top of its Effect and closes over `emit` and `callTool` for those callbacks (ADR-0027 "push, not pull").

## transport-memory.ts — InMemoryTransport

Test `Layer` for `WorkerTransport` (ADR-0027). `emit` pushes each Run Event into the caller's `captured` array; `callTool` records the Tool Request into `tools.requests` and returns the scripted Tool Result from `tools.results` (the bidirectional Tool Protocol channel, ADR-0006). Both arrays plus the scripted table ARE the assertions — no process, no readline, no stdout capture.

A chat-only run passes no `tools`; its manifest has no tool descriptors, so `callTool` is never invoked. If it ever is (a missing scripted result), the returned `Promise` rejects so the test fails loudly rather than hanging.

`readManifest` is a stub (`null`): the interpreter never reads the manifest through the seam (it is handed the manifest by `main`), so in-process interpreter tests don't exercise it. The real read+decode lives in `StdioTransportLive` and is covered by `transport-stdio.test.ts`.

## transport-stdio.ts — makeStdioService

Production transport (ADR-0027): the Worker's stdio behind the `WorkerTransport` seam. This is the sole module in the Worker's interpreter transport that touches `process.stdin`/`process.stdout` — the Provider Helper (`packages/provider-helper/src/provider.ts`, ADR-0023) is a separate binary with its own stdio and is out of scope here. Mirrors Core's `ChildWorker` as the sole `Command::spawn` site for the Worker (ADR-0026). It owns the single readline over stdin, the first-line manifest read (ADR-0013), the `tool_call_id` → resolver correlation map for the bidirectional Tool Protocol (ADR-0006), and the stdout NDJSON writer.

Built over injected `Readable`/`Writable` streams so the adapter is testable with fakes; `StdioTransportLive` binds it to the real process streams.

### Bidirectional stdio framing (ADR-0013)

A single readline over stdin. The FIRST line is the manifest; every subsequent line is a `tool_result` Core writes back, dispatched to the pending tool call keyed by `tool_call_id`.

Each post-manifest line is decoded STRICTLY against the single-source `ToolResult` schema (`S.decodeUnknownEither`), not waved through a truthiness check. A skewed frame (e.g. `outcome:{}`) no longer resolves the pending call with junk that later throws inside the proxy and reads as a tool error misattributed to the tool call — it fails loud at the seam: the correlation id is salvaged from the raw JSON (as with the manifest's `run_id`, #146) and the awaiting call is SETTLED with a `tool_result_decode_error` `err` outcome. The settle is what makes it loud — it stops the call hanging and hands the proxy a correctly-attributed decode error; the proxy throws on `err`, which pi turns into an error tool result fed back to the model (ADR-0018), so the Run continues rather than surfacing a mislabeled failure. A line that isn't JSON, or an undecodable line with no correlatable pending call, is logged and dropped (Core's single sequential flushed writer cannot produce such a line for a live pending call).
