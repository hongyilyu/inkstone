// Deterministic "run_id echo" worker fixture for Core's correlation-chain test.
//
// Speaks the Worker NDJSON protocol over stdio (a drop-in via
// `INKSTONE_WORKER_CMD`), but its single purpose is to ECHO the value Core set
// in `process.env.INKSTONE_RUN_ID` so the test can assert Core passed the Run's
// run_id to the worker child at spawn time (the ADR-0038 env seam; slice 6).
//
// Mechanism (A) FILE ECHO: the fixture writes a spawn-time env var (or "" when
// unset, the RED state before Core sets it) to a sink file, then drives a
// minimal valid Run to a terminal `done` so Core finalizes the Run cleanly. The
// test reads the sink after killing Core and asserts its contents.
//   - `INKSTONE_TEST_RUNID_SINK`   ← echoes `INKSTONE_RUN_ID` (slice 6 seam)
//   - `INKSTONE_TEST_LOGPATH_SINK` ← echoes `INKSTONE_WORKER_LOG_PATH` (the
//     default worker.jsonl path Core supplies so the Worker trail is written
//     by default, ADR-0038)
//
// Node builtins ONLY (no @inkstone/protocol) so it runs standalone via tsx from
// crates/core/tests/fixtures/.

import { writeFileSync } from "node:fs";
import { emit, stdinLines } from "./transport.js";

const main = async (): Promise<void> => {
	// Echo the spawn-time env var(s) to the requested sink(s). Before Core sets
	// them the vars are unset → `?? ""` writes an empty string (the RED observable).
	const runIdSink = process.env.INKSTONE_TEST_RUNID_SINK;
	if (runIdSink !== undefined && runIdSink.length > 0) {
		writeFileSync(runIdSink, process.env.INKSTONE_RUN_ID ?? "");
	}
	const logPathSink = process.env.INKSTONE_TEST_LOGPATH_SINK;
	if (logPathSink !== undefined && logPathSink.length > 0) {
		writeFileSync(logPathSink, process.env.INKSTONE_WORKER_LOG_PATH ?? "");
	}

	// First non-empty stdin line is the manifest; empty stdin -> exit 0.
	const lines = stdinLines();
	let line = await lines.next();
	while (line === "") line = await lines.next();
	if (line === null) return;

	const inbound = JSON.parse(line) as { prompt: string };

	// A real frame + terminal done so the Run completes normally and Core
	// finalizes it (no error path), keeping the test's wait-for-done a clean
	// barrier.
	emit({ kind: "text_delta", delta: `echo: ${inbound.prompt}` });
	emit({ kind: "done" });
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
