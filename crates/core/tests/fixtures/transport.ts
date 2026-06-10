// Shared stdio framing for the Core integration-test worker fixtures.
//
// The test-side mirror of the Worker's `StdioTransportLive` (ADR-0027): the
// stdout NDJSON writer and the single stdin line reader (first line = the
// manifest; later lines = the `tool_result`s Core writes back on the kept-open
// stdin). Each fixture keeps its own distinct behavior on top of these.
//
// Node builtins ONLY (no @inkstone/worker, no @inkstone/protocol, no npm deps)
// so each fixture still runs standalone via `tsx` through `INKSTONE_WORKER_CMD`.
// The production transport can't stand in here: it decodes a full
// `WorkerManifest` and its `callTool` always awaits a `tool_result`, whereas
// these fixtures speak reduced/variant protocols (slow-worker reads `{prompt}`
// and pauses mid-stream; propose-worker emits a `tool_request` then parks and is
// torn down without ever receiving a result).

import { createInterface } from "node:readline";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EPIPE") process.exit(0);
	throw error;
});

/** Write one NDJSON frame to stdout (one event per line). */
export const emit = (frame: unknown): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

/** A sequential reader over stdin lines. */
export interface StdinLines {
	/** The next stdin line in order, or `null` once stdin closes (EOF). */
	next(): Promise<string | null>;
	/** Close the reader so the process can exit once its work is done. */
	close(): void;
}

/**
 * Read stdin line-by-line over a single readline interface (the duplex stdin of
 * ADR-0013). Lines are delivered in order; `next()` resolves `null` after the
 * stream closes and the buffered lines are drained.
 */
export const stdinLines = (): StdinLines => {
	const rl = createInterface({ input: process.stdin });
	const queued: string[] = [];
	let waiting: ((line: string | null) => void) | null = null;
	let closed = false;

	rl.on("line", (line) => {
		if (waiting) {
			const resolve = waiting;
			waiting = null;
			resolve(line);
		} else {
			queued.push(line);
		}
	});
	rl.on("close", () => {
		closed = true;
		if (waiting) {
			const resolve = waiting;
			waiting = null;
			resolve(null);
		}
	});

	return {
		next: () =>
			new Promise<string | null>((resolve) => {
				const line = queued.shift();
				if (line !== undefined) resolve(line);
				else if (closed) resolve(null);
				else waiting = resolve;
			}),
		close: () => rl.close(),
	};
};
