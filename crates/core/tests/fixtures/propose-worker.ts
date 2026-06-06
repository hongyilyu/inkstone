// Deterministic park-on-propose test fixture for Core integration tests.
//
// Speaks the bidirectional Worker stdio protocol so it is a drop-in for the
// real worker via `INKSTONE_WORKER_CMD`:
//   - stdin (line 1): the full WorkerManifest JSON (one line).
//   - stdout:         one `propose_entity` `tool_request` line (a Todo
//                     payload), then it BLOCKS reading stdin forever.
//
// Park semantics (ADR-0025): when the Worker emits a `propose_entity`
// tool_request, Core persists the Proposal + tool_call, sets the Run to
// `parked`, and tears this Worker down (drops stdin → EOF). This fixture
// therefore never receives a tool_result; it just emits the request and
// waits to be killed. It must NOT emit `done` (that would defeat the park).
//
// Node builtins ONLY (no @inkstone/protocol, no npm deps) so it runs
// standalone via tsx, matching the tool-worker.ts convention.

import { createInterface } from "node:readline";

const emit = (event: unknown): void => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
};

const main = async (): Promise<void> => {
	// Read stdin line-by-line: line 1 is the manifest. We never read further
	// (no tool_result arrives — Core parks and tears us down).
	const rl = createInterface({ input: process.stdin });
	const lines: string[] = [];
	let resolveLine: ((line: string) => void) | null = null;
	rl.on("line", (line) => {
		if (resolveLine) {
			const r = resolveLine;
			resolveLine = null;
			r(line);
		} else {
			lines.push(line);
		}
	});
	const nextLine = (): Promise<string> =>
		new Promise((resolve) => {
			const queued = lines.shift();
			if (queued !== undefined) resolve(queued);
			else resolveLine = resolve;
		});

	// Consume the manifest line.
	const manifestLine = await nextLine();

	// Resume path (ADR-0025): on a `mode:"resume"` manifest, Core has applied
	// the Decision and is re-spawning us with the reconstructed transcript
	// (ending in the Decision tool_result). DON'T propose again — emit a short
	// completion and `done` so the Run reaches `completed`.
	let manifest: { mode?: string } = {};
	try {
		manifest = JSON.parse(manifestLine);
	} catch {
		// Malformed manifest — fall through to the fresh (propose) path.
	}
	if (manifest.mode === "resume") {
		emit({ kind: "text_delta", delta: "Done — added it." });
		emit({ kind: "done" });
		return;
	}

	// Optional pre-propose phase (INKSTONE_PROPOSE_DELAY_MS > 0): emit a
	// `text_delta` so the Run's hub is live and streaming, then wait. This lets
	// a test subscribe and attach to the LIVE hub BEFORE the park, so it can
	// assert the attached-forwarder path emits no false `done` when the Run
	// parks (ADR-0025 no-false-done). Default 0 → no delay, immediate propose
	// (the park-state test relies on this unchanged).
	const delayMs = Number(process.env.INKSTONE_PROPOSE_DELAY_MS ?? "0");
	if (delayMs > 0) {
		emit({ kind: "text_delta", delta: "thinking… " });
		await new Promise<void>((r) => setTimeout(r, delayMs));
	}

	// Emit one propose_entity tool_request for a Todo. `run_id` is
	// Core-ignored (Core uses the spawn's authoritative run id); send "" to
	// keep the wire shape. The tool_call_id is per-process (one worker per
	// Run) so it is unique across Runs.
	const toolCallId = `tc_${process.pid}`;
	emit({
		kind: "tool_request",
		run_id: "",
		tool_call_id: toolCallId,
		name: "propose_entity",
		params: {
			type: "todo",
			data: { title: "buy milk", done: false },
			rationale: "the user asked to remember this",
		},
	});

	// Block forever — Core parks the Run and tears this process down by
	// dropping stdin (EOF). We never emit `done`.
	await new Promise<void>(() => {});
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
