// Deterministic park-on-propose test fixture for Core integration tests.
//
// Speaks the bidirectional Worker stdio protocol so it is a drop-in for the
// real worker via `INKSTONE_WORKER_CMD`:
//   - stdin (line 1): the full WorkerManifest JSON (one line).
//   - stdout:         one `propose_entity` `tool_request` line (a Todo payload
//                     by default; a Person payload when
//                     INKSTONE_PROPOSE_KIND=person), then it BLOCKS reading
//                     stdin forever.
//
// Park semantics (ADR-0025): when the Worker emits a `propose_entity`
// tool_request, Core persists the Proposal + tool_call, sets the Run to
// `parked`, and tears this Worker down (drops stdin → EOF). This fixture
// therefore never receives a tool_result; it just emits the request and
// waits to be killed. It must NOT emit `done` (that would defeat the park).
//
// Node builtins ONLY (no @inkstone/protocol, no npm deps) so it runs
// standalone via tsx, matching the tool-worker.ts convention.

import { emit, stdinLines } from "./transport.js";

const main = async (): Promise<void> => {
	// Read stdin line-by-line: line 1 is the manifest. In the park path we never
	// read further (no tool_result arrives — Core parks and tears us down).
	const lines = stdinLines();

	// Consume the manifest line.
	const manifestLine = await lines.next();
	if (manifestLine === null) return;

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

	// Multi-step fresh path (INKSTONE_MULTISTEP=1): prove Core reconstructs a
	// provider-valid MULTI-step transcript on resume (ADR-0025). The worker
	// FIRST emits an assistant text turn + a real `read_thread` tool_request,
	// which Core executes synchronously and resolves (a resolved tool_call →
	// rendered as a paired `tool_result`), THEN emits `propose_entity` (which
	// parks). On resume Core must rebuild: assistant{text} → assistant{tool_call
	// read_thread} → tool_result(read_thread) → assistant{tool_call propose} →
	// tool_result(Decision) — with NO orphan tool_result. We pass a valid-but-
	// nonexistent thread_id so read_thread resolves deterministically (a
	// `not_found` error result is still a resolved tool_call to reconstruct).
	if (process.env.INKSTONE_MULTISTEP === "1") {
		emit({ kind: "text_delta", delta: "Let me check the other thread. " });
		const readCallId = `tc_read_${process.pid}`;
		emit({
			kind: "tool_request",
			run_id: "",
			tool_call_id: readCallId,
			name: "read_thread",
			params: { thread_id: "00000000-0000-0000-0000-000000000000" },
		});
		// Wait for Core's tool_result (read_thread resolved), then propose.
		await lines.next();
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
		// Block forever — Core parks and tears us down (drops stdin → EOF).
		await new Promise<void>(() => {});
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

	// Emit one propose_entity tool_request. `run_id` is Core-ignored (Core uses
	// the spawn's authoritative run id); send "" to keep the wire shape. The
	// tool_call_id is per-process (one worker per Run) so it is unique across
	// Runs. The proposed Entity Type is gated on INKSTONE_PROPOSE_KIND: "person"
	// emits a Person payload (slice 1); unset/"todo" stays the original Todo
	// behavior so the existing tests are unaffected.
	const toolCallId = `tc_${process.pid}`;
	const params =
		process.env.INKSTONE_PROPOSE_KIND === "person"
			? {
					type: "person",
					data: { name: "Alice", note: "met at the daycare" },
					rationale: "the user mentioned someone worth remembering",
				}
			: {
					type: "todo",
					data: { title: "buy milk", done: false },
					rationale: "the user asked to remember this",
				};
	emit({
		kind: "tool_request",
		run_id: "",
		tool_call_id: toolCallId,
		name: "propose_entity",
		params,
	});

	// Block forever — Core parks the Run and tears this process down by
	// dropping stdin (EOF). We never emit `done`.
	await new Promise<void>(() => {});
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
