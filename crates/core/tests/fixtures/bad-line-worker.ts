// Deterministic "bad line" worker fixture for Core's Diagnostic Log tests.
//
// Speaks the Worker NDJSON protocol over stdio (a drop-in via
// `INKSTONE_WORKER_CMD`), but deliberately writes ONE malformed, non-NDJSON
// line to stdout BEFORE its real frames. Core's `child.rs` stdout reader fails
// to deserialize that line as a `WorkerStdout`, hits the "worker emitted unknown
// line" arm — `tracing::warn!(event="worker.unknown_line", …)` — and terminates
// the Run. The test waits for Core's error event, then asserts the diagnostic
// carries the Run's `run_id` as a top-level field, proving correlation reaches
// a child.rs site
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

	// SAFETY: Core writes the manifest line, which always carries `prompt`.
	const inbound = JSON.parse(line) as { prompt: string };

	// The malformed line: valid UTF-8, but NOT a JSON `WorkerStdout` frame, so
	// `serde_json::from_str::<WorkerStdout>` fails and Core terminates the Run.
	process.stdout.write("this is not a worker frame\n");

	// These frames prove Core does not continue after the protocol violation.
	emit({ kind: "text_delta", delta: `echo: ${inbound.prompt}` });
	emit({ kind: "done" });
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
