import type { WorkerManifest, WorkerRunEvent } from "@inkstone/protocol";
import { Context, Data, type Effect } from "effect";
import type { CallTool } from "./tool-proxy.js";

/** The manifest line on stdin was present but not a valid {@link WorkerManifest}.
 * `runId` is the best-effort run_id salvaged from the raw JSON when the line
 * parsed as JSON but failed schema validation (e.g. Rust↔TS mirror skew, #146) —
 * absent only when the line was not even valid JSON, so the diagnostic line for a
 * schema-skew failure still joins to core.jsonl by run. */
export class ManifestParseError extends Data.TaggedError("ManifestParseError")<{
	readonly message: string;
	readonly runId?: string;
}> {}

/** Worker-side transport seam: the single service the interpreter talks to instead of touching stdio (ADR-0027). See docs/design/worker-transport.md. */
export class WorkerTransport extends Context.Tag(
	"@inkstone/worker/WorkerTransport",
)<
	WorkerTransport,
	{
		/** Read + decode the manifest (first stdin line, ADR-0013); `null` on empty input, fails {@link ManifestParseError} on an invalid line. */
		readonly readManifest: Effect.Effect<
			WorkerManifest | null,
			ManifestParseError
		>;
		/** Emit one Run Event (fire-and-forget; ADR-0006 Run Event channel). */
		readonly emit: (event: WorkerRunEvent) => void;
		/** Round-trip one Tool Request to Core and await its Tool Result (bidirectional Tool Protocol; ADR-0006). Same shape as the proxy's {@link CallTool}. */
		readonly callTool: CallTool;
	}
>() {}
