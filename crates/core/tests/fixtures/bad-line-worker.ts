// Deterministic "bad line" worker fixture for Core's Diagnostic Log tests.
//
// Speaks the Worker NDJSON protocol over stdio (a drop-in via
// `INKSTONE_WORKER_CMD`), but deliberately writes ONE malformed, non-NDJSON
// line to stdout BEFORE its real frames. Core's `child.rs` stdout reader fails
// to deserialize that line as a `WorkerStdout`, hits the "worker emitted unknown
// line" arm — `tracing::warn!(event="worker.unknown_line", …)` — and `continue`s
// to the next line. The fixture then emits a normal `text_delta` + `done`, so
// the Run still completes; the test drives the Run to `done` (which can only
// arrive AFTER the bad line was read and skipped), then reads the trail and
// asserts the `worker.unknown_line` event carries the Run's `run_id` as a
// top-level field — proving run_id correlation reaches a child.rs site
// (threaded into `ChildWorker::spawn`; the `worker_run` span is retained for
// transitive dep events). See ADR-0038.
//
// Node builtins ONLY (no @inkstone/protocol) so it runs standalone via tsx from
// crates/core/tests/fixtures/.

import { emit, stdinLines } from "./transport.js";

const main = async (): Promise<void> => {
	// First non-empty stdin line is the manifest; empty stdin -> exit 0.
	const lines = stdinLines();
	let line = await lines.next();
	while (line === "") line = await lines.next();
	if (line === null) return;

	const inbound = JSON.parse(line) as { prompt: string };

	// The malformed line: valid UTF-8, but NOT a JSON `WorkerStdout` frame, so
	// `serde_json::from_str::<WorkerStdout>` fails and Core logs + skips it.
	process.stdout.write("this is not a worker frame\n");

	// A real frame + terminal done so the Run completes normally. Because Core's
	// reader is sequential, `done` is only delivered after the bad line above was
	// read and skipped — making the test's wait-for-done a deterministic barrier.
	emit({ kind: "text_delta", delta: `echo: ${inbound.prompt}` });
	emit({ kind: "done" });
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
