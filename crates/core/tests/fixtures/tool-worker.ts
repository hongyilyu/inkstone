// Deterministic tool-protocol test fixture for Core integration tests.
//
// Speaks the bidirectional Worker stdio protocol (slice 2 of the Tool
// Protocol) so it is a drop-in for the real worker via `INKSTONE_WORKER_CMD`:
//   - stdin (line 1):  the full WorkerManifest JSON (one line).
//   - stdout:          one `tool_request` line, then (after the reply) a
//                      `text_delta` echoing the outcome, then `done`.
//   - stdin (line 2):  the `tool_result` Core writes back (kept-open stdin).
//
// It exercises the duplex: emit a tool_request, BLOCK reading stdin for the
// matching tool_result, then report what it got on the stream so the test can
// assert the round-trip from outside (subscribe stream) and in the DB.
//
// Node builtins ONLY (no @inkstone/protocol, no npm deps) so it runs standalone
// via tsx, matching the slow-worker.ts convention.
//
// === ENV CONTRACT ===
//
// INKSTONE_TOOLWORKER_TOOL
//   The tool name to request. Default "read_thread" (in the default Workflow's
//   allowlist → Core dispatches it). Set to an off-list name (e.g.
//   "nonexistent") to exercise allowlist rejection → Core returns an `err`
//   outcome and the fixture echoes `tool_outcome=err:<code>`.
//
// INKSTONE_TOOLWORKER_THREAD_ID_FILE
//   A filesystem path. If set AND the file exists, its trimmed contents are
//   the `thread_id` passed to read_thread (lets a test point the call at a
//   real, just-created thread). Absent/missing → the default "t-dummy", which
//   is an unknown id (→ Core returns a `not_found` error outcome).
//
// INKSTONE_TOOLWORKER_GATE
//   A filesystem path. When set, the fixture BLOCKS after the tool round-trip
//   (it has received Core's tool_result) and BEFORE emitting the final
//   `text_delta`/`done`, polling until the path exists. Lets a test land a
//   `run/cancel` deterministically after a real tool dispatch persisted its
//   rows but before the turn completes. Unset => no pause.

import { existsSync, readFileSync } from "node:fs";
import { emit, stdinLines } from "./transport.js";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const waitForGate = async (path: string): Promise<void> => {
	while (!existsSync(path)) {
		await sleep(10);
	}
};

interface Manifest {
	workflow?: { tools?: Array<{ name?: string }> };
}

interface ToolResultLine {
	kind?: string;
	tool_call_id?: string;
	outcome?: {
		ok?: { content?: Array<{ type?: string; text?: string }> };
		err?: { code?: string; message?: string };
	};
}

const main = async (): Promise<void> => {
	const tool = process.env.INKSTONE_TOOLWORKER_TOOL ?? "read_thread";

	// Read the bidirectional stdin line-by-line: line 1 is the manifest, the
	// next line (after we emit the request) is the tool_result.
	const lines = stdinLines();

	const manifestLine = await lines.next();
	if (manifestLine === null) return;
	const manifest = JSON.parse(manifestLine) as Manifest;

	// In the default (happy) mode, prove Core shipped the read_thread
	// descriptor in the manifest.
	if (tool === "read_thread") {
		const present = (manifest.workflow?.tools ?? []).some(
			(t) => t?.name === "read_thread",
		);
		if (!present) {
			emit({ kind: "error", message: "read_thread descriptor missing from manifest" });
			return;
		}
	}

	// Emit one tool_request. `run_id` is Core-ignored (Core uses the spawn's
	// authoritative run id); send "" to keep the wire shape. The thread_id is
	// read from the id-file when present, else the unknown "t-dummy". The
	// tool_call_id is per-process (one worker process per Run) so it is unique
	// across Runs — `tool_calls.id` is a global primary key.
	const idFile = process.env.INKSTONE_TOOLWORKER_THREAD_ID_FILE;
	const threadId =
		idFile && existsSync(idFile) ? readFileSync(idFile, "utf8").trim() : "t-dummy";
	const toolCallId = `tc_${process.pid}`;
	emit({
		kind: "tool_request",
		run_id: "",
		tool_call_id: toolCallId,
		name: tool,
		params: { thread_id: threadId },
	});

	// Block for the tool_result Core writes back on stdin.
	const resultLine = await lines.next();
	if (resultLine === null) return;
	const result = JSON.parse(resultLine) as ToolResultLine;

	let outcome: string;
	if (result.kind !== "tool_result" || result.tool_call_id !== toolCallId) {
		outcome = "malformed";
	} else if (result.outcome?.ok) {
		const text = result.outcome.ok.content?.[0]?.text ?? "";
		outcome = `ok:${text}`;
	} else if (result.outcome?.err) {
		outcome = `err:${result.outcome.err.code ?? "?"}`;
	} else {
		outcome = "malformed";
	}

	// Optional pause AFTER the tool round-trip (rows persisted) and BEFORE the
	// terminal events, so a test can cancel a live, mid-turn Run deterministically.
	const gate = process.env.INKSTONE_TOOLWORKER_GATE;
	if (gate !== undefined && gate.length > 0) {
		await waitForGate(gate);
	}

	emit({ kind: "text_delta", delta: `tool_outcome=${outcome}` });
	emit({ kind: "done" });
	lines.close();
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
