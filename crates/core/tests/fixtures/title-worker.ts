// Deterministic one-shot title-worker test fixture (ADR-0046).
//
// Stands in for the real title Worker via INKSTONE_TITLE_WORKER_CMD: it reads
// the first stdin line (the bespoke title WorkerManifest — parsed but mostly
// ignored), then emits a single text_delta + done. The emitted title is
// scripted by env so a Core test can assert both the overwrite and the
// placeholder-kept paths:
//
//   INKSTONE_TITLE_FIXTURE_OUTPUT
//     When set, emit its value as a single text_delta, then done. This is the
//     model's raw title reply Core sanitizes before persisting.
//
//   INKSTONE_TITLE_FIXTURE_EMPTY=1
//     Emit a whitespace-only text_delta ("   ") then done — sanitize → None, so
//     Core keeps the prompt-derived placeholder (the placeholder-kept test).
//
//   INKSTONE_TITLE_FIXTURE_HANG=1
//     Emit ONE partial text_delta then BLOCK FOREVER — never emit done. Core's
//     collector must time out, kill this worker (kill_on_drop), and keep the
//     placeholder (the timeout test). The worker exits only when Core drops it.
//
//   (none set)
//     Emit a default "Generated Title" then done.
//
// Node builtins ONLY (via ./transport.js, like slow-worker.ts) so it runs
// standalone via tsx through INKSTONE_TITLE_WORKER_CMD. The manifest's
// access_token is never consulted — the fixture is offline.

import { emit, stdinLines } from "./transport.js";

const main = async (): Promise<void> => {
	// First non-empty stdin line (the WorkerManifest JSON); empty stdin → exit 0
	// without emitting. Core always newline-terminates its manifest write.
	const lines = stdinLines();
	let line = await lines.next();
	while (line === "") line = await lines.next();
	if (line === null) return; // empty stdin -> exit 0 without emitting

	// Parse the manifest to mirror the real Worker's first move, but the fixture
	// does not depend on any of its fields (the title is scripted via env).
	JSON.parse(line);

	// Hang mode: emit one partial delta, then never settle — no done, no exit.
	// Core's collector must time out and kill us (kill_on_drop reaps the child).
	const hang = process.env.INKSTONE_TITLE_FIXTURE_HANG;
	if (hang !== undefined && hang.length > 0) {
		emit({ kind: "text_delta", delta: "partial" });
		await new Promise<void>(() => {}); // block forever — never resolves
	}

	const empty = process.env.INKSTONE_TITLE_FIXTURE_EMPTY;
	const output = process.env.INKSTONE_TITLE_FIXTURE_OUTPUT;
	const delta =
		empty !== undefined && empty.length > 0
			? "   "
			: (output ?? "Generated Title");

	emit({ kind: "text_delta", delta });
	emit({ kind: "done" });
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
