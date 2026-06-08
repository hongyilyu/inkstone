import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import { Context, Data, type Effect } from "effect";
import type { CallTool } from "./tool-proxy.js";

/** The manifest line on stdin was present but not a valid {@link WorkerManifest}. */
export class ManifestParseError extends Data.TaggedError("ManifestParseError")<{
	readonly message: string;
}> {}

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
 *     a Tool Result — NEVER fire-and-forget);
 *   - `readManifest` (read + decode the manifest once at startup; ADR-0013).
 *
 * `emit` is intentionally a SYNCHRONOUS method: it is called from
 * `pi-agent-core`'s synchronous `onEvent` sink, which runs outside the Effect
 * context. `callTool` returns a `Promise` because `pi-agent-core`'s tool
 * `execute` is a `Promise`-returning callback. `readManifest` is an `Effect`
 * because it is awaited once from `main`'s Effect (ADR-0020). The interpreter
 * obtains the transport once at the top of its Effect and closes over `emit`
 * and `callTool` for those callbacks (ADR-0027 "push, not pull").
 */
export class WorkerTransport extends Context.Tag("@inkstone/worker/WorkerTransport")<
	WorkerTransport,
	{
		/**
		 * Read + decode the manifest, the first stdin line (ADR-0013). `null`
		 * when stdin closes with no line (empty input → clean exit); fails with
		 * {@link ManifestParseError} when the line is not a valid manifest.
		 */
		readonly readManifest: Effect.Effect<WorkerManifest | null, ManifestParseError>;
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
