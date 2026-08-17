# worker-transport

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## transport.ts — WorkerTransport

The Worker-side transport seam (ADR-0027): the single service the generic interpreter (ADR-0018) talks to instead of touching `process.stdin`/`stdout` directly. Two `Layer`s satisfy it — a production `StdioTransportLive` and a test-only `InMemoryTransport` — so the interpreter's run-driving logic is unit-testable in-process.

The seam exposes the two ADR-0006 channels plus the external lifecycle durability barrier:
- `emit` (one-way, fire-and-forget Run Events);
- `syncExternalTool` (emit one external lifecycle frame and await Core's durable ACK);
- `callTool` (the bidirectional Tool Protocol: a Tool Request paired with a Tool Result — NEVER fire-and-forget);
- `readManifest` (read + decode the manifest once at startup; ADR-0013).

`emit` is intentionally a SYNCHRONOUS method: it is called from `pi-agent-core`'s synchronous `onEvent` sink, which runs outside the Effect context. `syncExternalTool` and `callTool` return `Promise`s because both must await Core from pi's callbacks. `readManifest` is an `Effect` because it is awaited once from `main`'s Effect (ADR-0020). The interpreter obtains the transport once at the top of its Effect and closes over these operations (ADR-0027 "push, not pull").

## transport-memory.ts — InMemoryTransport

Test `Layer` for `WorkerTransport` (ADR-0027). `emit` pushes each Run Event into the caller's `captured` array; `syncExternalTool` pushes its lifecycle frame there and optionally invokes a scripted durability barrier; `callTool` records the Tool Request into `tools.requests` and returns the scripted Tool Result from `tools.results`. The captured arrays, callback, and scripted table ARE the assertions — no process, no readline, no stdout capture.

A chat-only run passes no `tools`; its manifest has no tool descriptors, so `callTool` is never invoked. If it ever is (a missing scripted result), the returned `Promise` rejects so the test fails loudly rather than hanging.

`readManifest` is a stub (`null`): the interpreter never reads the manifest through the seam (it is handed the manifest by `main`), so in-process interpreter tests don't exercise it. The real read+decode lives in `StdioTransportLive` and is covered by `transport-stdio.test.ts`.

## transport-stdio.ts — makeStdioService

Production transport (ADR-0027): the Worker's stdio behind the `WorkerTransport` seam. This is the sole module in the Worker's interpreter transport that touches `process.stdin`/`process.stdout` — the Provider Helper (`packages/provider-helper/src/provider.ts`, ADR-0023) is a separate binary with its own stdio and is out of scope here. Mirrors Core's `ChildWorker` as the sole `Command::spawn` site for the Worker (ADR-0026). It owns the single readline over stdin, the first-line manifest read (ADR-0013), the pending Tool Result map keyed by `tool_call_id`, the pending external ACK map keyed by `phase + tool_call_id`, and the stdout NDJSON writer.

Built over injected `Readable`/`Writable` streams so the adapter is testable with fakes; `StdioTransportLive` binds it to the real process streams.

### Bidirectional stdio framing (ADR-0013)

A single readline over stdin. The FIRST line is the manifest; every subsequent line is a `WorkerInbound` frame Core writes back: either a `tool_result` or an `external_tool_ack`. Each Worker process and stdin pipe belongs to exactly one Run, established by the manifest, so an external ACK does not repeat `run_id`; `tool_call_id` + lifecycle `phase` identify the pending acknowledgement.

Each post-manifest line is decoded STRICTLY against the shared `WorkerInbound` union (`S.decodeUnknownEither`), not waved through a truthiness check. A skewed tool result (e.g. `outcome:{}`) no longer resolves the pending call with junk that later throws inside the proxy and reads as a tool error misattributed to the tool call — it fails loud at the seam: the correlation id is salvaged from the raw JSON (as with the manifest's `run_id`, #146) and the awaiting call is SETTLED with a `tool_result_decode_error` `err` outcome. An undecodable external ACK similarly rejects its uniquely correlatable pending lifecycle frame. These settlements stop calls hanging; a line that isn't JSON, or an undecodable line with no correlatable pending call, is logged and dropped.
