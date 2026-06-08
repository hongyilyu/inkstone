import type { RunEvent } from "@inkstone/protocol";
import { Context } from "effect";
import type { CallTool } from "./tool-proxy.js";

/**
 * The Worker-side transport seam (ADR-0027): the single service the generic
 * interpreter (ADR-0018) talks to instead of touching `process.stdin`/`stdout`
 * directly. Two `Layer`s satisfy it — a production `StdioTransportLive` and a
 * test-only `InMemoryTransport` — so the interpreter's run-driving logic is
 * unit-testable in-process.
 *
 * This slice wires both logical channels of ADR-0006:
 *   - `emit` (one-way, fire-and-forget Run Events);
 *   - `callTool` (the bidirectional Tool Protocol: a Tool Request paired with
 *     a Tool Result — NEVER fire-and-forget).
 * The seam grows `readManifest` (read the manifest once at startup) in slice 3.
 *
 * `emit` is intentionally a SYNCHRONOUS method: it is called from
 * `pi-agent-core`'s synchronous `onEvent` sink, which runs outside the Effect
 * context. `callTool` returns a `Promise` because `pi-agent-core`'s tool
 * `execute` is a `Promise`-returning callback. The interpreter obtains the
 * transport once at the top of its Effect and closes over both for those
 * callbacks (ADR-0027 "push, not pull").
 */
export class WorkerTransport extends Context.Tag("@inkstone/worker/WorkerTransport")<
	WorkerTransport,
	{
		/** Emit one Run Event (fire-and-forget; ADR-0006 Run Event channel). */
		readonly emit: (event: RunEvent) => void;
		/**
		 * Round-trip one Tool Request to Core and await its Tool Result
		 * (bidirectional; ADR-0006 Tool Protocol channel). Same shape as the
		 * proxy's {@link CallTool}: on an `err` outcome the proxy throws.
		 */
		readonly callTool: CallTool;
	}
>() {}
