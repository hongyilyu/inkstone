import type { RunEvent } from "@inkstone/protocol";
import { Context } from "effect";

/**
 * The Worker-side transport seam (ADR-0027): the single service the generic
 * interpreter (ADR-0018) talks to instead of touching `process.stdin`/`stdout`
 * directly. Two `Layer`s satisfy it — a production `StdioTransportLive` and a
 * test-only `InMemoryTransport` — so the interpreter's run-driving logic is
 * unit-testable in-process.
 *
 * This slice wires only `emit` (one-way Run Events, the fire-and-forget
 * channel of ADR-0006). The seam grows the other two operations in later
 * slices:
 *   - `callTool` (the bidirectional Tool Protocol channel) — slice 2;
 *   - `readManifest` (read the manifest once at startup) — slice 3.
 *
 * `emit` is intentionally a SYNCHRONOUS method: it is called from
 * `pi-agent-core`'s synchronous `onEvent` sink, which runs outside the Effect
 * context. The interpreter obtains the transport once at the top of its Effect
 * and closes over `emit` for that callback (ADR-0027 "push, not pull").
 */
export class WorkerTransport extends Context.Tag("@inkstone/worker/WorkerTransport")<
	WorkerTransport,
	{
		/** Emit one Run Event (fire-and-forget; ADR-0006 Run Event channel). */
		readonly emit: (event: RunEvent) => void;
	}
>() {}
