// Deterministic one-shot liveness-probe worker fixture (ADR-0062, provider/test).
//
// Stands in for the ephemeral liveness Worker via INKSTONE_WORKER_CMD: it reads
// the first stdin line (the bespoke ping WorkerManifest — parsed but ignored),
// then emits frames scripted by env so a Core test can assert both the alive and
// the dead paths without needing two fixtures:
//
//   (none set)
//     Emit a single text_delta ("pong") then done — the liveness ALIVE path
//     (Core returns { alive: true }).
//
//   INKSTONE_LIVENESS_ERROR=<message>
//     Emit an `error` frame carrying <message> — the liveness DEAD path (Core
//     returns { alive: false, message: <message> }).
//
// Node builtins ONLY (via ./transport.js, like title-worker.ts) so it runs
// standalone via tsx through INKSTONE_WORKER_CMD. The manifest's access_token is
// never consulted — the fixture is offline.

import { emit, stdinLines } from "./transport.js";

const main = async (): Promise<void> => {
	// First non-empty stdin line (the WorkerManifest JSON); empty stdin → exit 0
	// without emitting. Core always newline-terminates its manifest write.
	const lines = stdinLines();
	let line = await lines.next();
	while (line === "") line = await lines.next();
	if (line === null) return; // empty stdin -> exit 0 without emitting

	// Parse the manifest to mirror the real Worker's first move, but the fixture
	// does not depend on any of its fields (the outcome is scripted via env).
	JSON.parse(line);

	const error = process.env.INKSTONE_LIVENESS_ERROR;
	if (error !== undefined && error.length > 0) {
		emit({ kind: "error", message: error });
		return;
	}

	emit({ kind: "text_delta", delta: "pong" });
	emit({ kind: "done" });
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
