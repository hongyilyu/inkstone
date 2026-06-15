import { appendFileSync } from "node:fs";

// Env-gated worker.jsonl Diagnostic Log sink — the sibling to Core's core.jsonl
// an agent joins by run_id (ADR-0036). Models tool-proxy.ts's captureToolCall
// appendFileSync pattern, but ADDS the try/catch that one lacks: a logging fs
// failure must NEVER throw into the Worker or mask the real fault.

/**
 * Append one structured fault line to the worker.jsonl Diagnostic Log.
 *
 * No-op when `INKSTONE_WORKER_LOG_PATH` is unset/empty (mirrors captureToolCall's
 * env gate). `run_id` comes from `INKSTONE_RUN_ID` (Core sets it at spawn time,
 * ADR-0036 / issue #146; empty string until then). `event` is a top-level field,
 * matching Core's convention. The fs write is wrapped so the logger itself can
 * never crash the Worker — this is the one acceptable silent swallow.
 */
export function logWorkerFault(
	event: string,
	fields?: Record<string, unknown>,
): void {
	const path = process.env.INKSTONE_WORKER_LOG_PATH;
	if (path === undefined || path.length === 0) return;
	const run_id = process.env.INKSTONE_RUN_ID ?? "";
	try {
		appendFileSync(path, `${JSON.stringify({ event, run_id, ...fields })}\n`);
	} catch {
		// A logging fs failure must never throw into the Worker or mask the real
		// fault — swallow it (the one acceptable swallow: it's the logger itself).
	}
}
