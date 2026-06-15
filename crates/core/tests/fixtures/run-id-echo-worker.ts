// Deterministic "run_id echo" worker fixture for Core's correlation-chain test.
//
// Speaks the Worker NDJSON protocol over stdio (a drop-in via
// `INKSTONE_WORKER_CMD`), but its single purpose is to ECHO the value Core set
// in `process.env.INKSTONE_RUN_ID` so the test can assert Core passed the Run's
// run_id to the worker child at spawn time (the ADR-0036 env seam; slice 6).
//
// Mechanism (A) FILE ECHO: the fixture writes `INKSTONE_RUN_ID` (or "" when
// unset, which is the RED state before child.rs sets it) to the sink file at
// `process.env.INKSTONE_TEST_RUNID_SINK`, then drives a minimal valid Run to a
// terminal `done` so Core finalizes the Run cleanly. The test reads the sink
// after killing Core and asserts its trimmed contents equal the Run's run_id.
//
// Node builtins ONLY (no @inkstone/protocol) so it runs standalone via tsx from
// crates/core/tests/fixtures/.

import { writeFileSync } from "node:fs";
import { emit, stdinLines } from "./transport.js";

const main = async (): Promise<void> => {
	// Echo the spawn-time env var to the sink. Before child.rs sets it the var
	// is unset → `?? ""` writes an empty string (the RED observable).
	const sink = process.env.INKSTONE_TEST_RUNID_SINK;
	if (sink !== undefined && sink.length > 0) {
		writeFileSync(sink, process.env.INKSTONE_RUN_ID ?? "");
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
