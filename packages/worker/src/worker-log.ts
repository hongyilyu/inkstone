import { appendFileSync } from "node:fs";

// Env-gated worker.jsonl Diagnostic Log sink — the sibling to Core's core.jsonl
// an agent joins by run_id (ADR-0038). Models tool-proxy.ts's captureToolCall
// appendFileSync pattern, but ADDS the try/catch that one lacks: a logging fs
// failure must NEVER throw into the Worker or mask the real fault.

/**
 * Append one structured fault line to the worker.jsonl Diagnostic Log.
 *
 * No-op when `INKSTONE_WORKER_LOG_PATH` is unset/empty (mirrors captureToolCall's
 * env gate). `runId` is passed in by the caller — it is the Run's id, carried
 * in-band via the WorkerManifest (ADR-0038 / issue #146). `event` is a top-level
 * field, matching Core's convention. The fs write is wrapped so the logger itself
 * can never crash the Worker — this is the one acceptable silent swallow.
 */
export function logWorkerFault(
	event: string,
	runId: string,
	fields?: Record<string, unknown>,
): void {
	const path = process.env.INKSTONE_WORKER_LOG_PATH;
	if (path === undefined || path.length === 0) return;
	try {
		appendFileSync(
			path,
			`${JSON.stringify({ event, run_id: runId, ...fields })}\n`,
		);
	} catch {
		// A logging fs failure must never throw into the Worker or mask the real
		// fault — swallow it (the one acceptable swallow: it's the logger itself).
	}
}
