// Deterministic slow-worker test fixture for Core integration tests.
//
// Speaks the existing Worker NDJSON protocol so it is a drop-in for the real
// worker via `INKSTONE_WORKER_CMD`:
//   - stdin:  reads exactly one line, a JSON object `{"prompt":"<text>"}`.
//   - stdout: NDJSON, one event per line, each flushed:
//               {"kind":"text_delta","delta":"<piece>"}   (zero or more)
//               {"kind":"done"}                            (terminal)
//
// Unlike the real worker (which emits ONE cumulative `text_delta` of
// `echo: <prompt>` then `done`), this fixture can split that same output into N
// INCREMENTAL pieces and pause mid-stream on a test-controlled gate, so tests
// can assert "paused mid-stream" deterministically without wall-clock sleeps.
//
// Node builtins ONLY (no @inkstone/protocol, no npm deps) so it runs standalone
// from crates/core/tests/fixtures/ via tsx.
//
// === STABLE ENV-VAR CONTRACT (slices 1/2/6 depend on this) ===
//
// INKSTONE_FIXTURE_CHUNKS
//   Integer N >= 1. Split `echo: <prompt>` into N roughly-equal INCREMENTAL
//   pieces (concatenation of all pieces === `echo: <prompt>`), each emitted as
//   its own text_delta. The first `len % N` pieces are one char longer. These
//   are INCREMENTAL, not cumulative — Core's append-in-place model concatenates
//   deltas, so the reassembled text equals the real worker's cumulative output.
//   Unset (or < 1 / non-integer) => N = 1: a single text_delta of the whole
//   `echo: <prompt>`, then done — identical to the real worker.
//
// INKSTONE_FIXTURE_GATE
//   A filesystem path. The fixture emits the FIRST chunk, then BLOCKS until this
//   path exists (polling fs.existsSync every 10ms — NOT a fixed sleep), then
//   emits the remaining chunks + done. The test trips the gate by creating the
//   file once it has set up the mid-stream condition it wants to assert.
//   Unset => emit all chunks + done immediately, no pause (degenerate fast mode).
//
// INKSTONE_FIXTURE_ERROR
//   A string. When set and non-empty, the fixture emits all chunks (honoring the
//   gate if set), then emits {"kind":"error","message":"<value>"} as its TERMINAL
//   event INSTEAD OF done — the worker-emitted error path (ADR-0023). Unset =>
//   normal done termination.
//
// On empty stdin (no newline-terminated line, mirroring the real worker's
// `Stream.runHead === None` case) the fixture exits 0 without emitting.

import { existsSync } from "node:fs";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const emit = (event: unknown): void => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
};

/**
 * Resolve the first non-empty, newline-terminated line of stdin, or null on EOF
 * with no such line. Mirrors the real worker: only `\n`-terminated lines count;
 * a trailing fragment without a newline is dropped.
 */
const readFirstLine = (): Promise<string | null> =>
	new Promise((resolve) => {
		let buf = "";
		let done = false;
		const finish = (value: string | null): void => {
			if (done) return;
			done = true;
			resolve(value);
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			if (done) return;
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.length > 0) {
					finish(line);
					return;
				}
				nl = buf.indexOf("\n");
			}
		});
		process.stdin.on("end", () => finish(null));
		process.stdin.on("error", () => finish(null));
	});

/** Split `text` into N roughly-equal incremental pieces (concat === text). */
const chunkText = (text: string, n: number): string[] => {
	const pieces: string[] = [];
	const base = Math.floor(text.length / n);
	const rem = text.length % n;
	let idx = 0;
	for (let i = 0; i < n; i++) {
		const size = base + (i < rem ? 1 : 0);
		pieces.push(text.slice(idx, idx + size));
		idx += size;
	}
	return pieces;
};

const waitForGate = async (path: string): Promise<void> => {
	// Poll-stat loop, yielding to the event loop each tick so already-written
	// stdout flushes to the pipe before we block.
	while (!existsSync(path)) {
		await sleep(10);
	}
};

const main = async (): Promise<void> => {
	const line = await readFirstLine();
	if (line === null) return; // empty stdin -> exit 0 without emitting

	const inbound = JSON.parse(line) as { prompt: string };
	const text = `echo: ${inbound.prompt}`;

	const rawChunks = process.env.INKSTONE_FIXTURE_CHUNKS;
	const parsed = rawChunks === undefined ? 1 : Number.parseInt(rawChunks, 10);
	const n = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;

	const pieces = chunkText(text, n);
	const gate = process.env.INKSTONE_FIXTURE_GATE;

	// Emit the first chunk, then pause on the gate (if set) before the rest.
	emit({ kind: "text_delta", delta: pieces[0] });
	if (gate !== undefined && gate.length > 0) {
		await waitForGate(gate);
	}
	for (let i = 1; i < pieces.length; i++) {
		emit({ kind: "text_delta", delta: pieces[i] });
	}

	// Terminal event: a worker-emitted error (ADR-0023) when configured,
	// otherwise the normal done.
	const errorMessage = process.env.INKSTONE_FIXTURE_ERROR;
	if (errorMessage !== undefined && errorMessage.length > 0) {
		emit({ kind: "error", message: errorMessage });
	} else {
		emit({ kind: "done" });
	}
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
