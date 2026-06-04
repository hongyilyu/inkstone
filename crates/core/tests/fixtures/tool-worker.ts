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

import { createInterface } from "node:readline";

const emit = (event: unknown): void => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
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

	const manifestLine = await nextLine();
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
	// authoritative run id); send "" to keep the wire shape.
	emit({
		kind: "tool_request",
		run_id: "",
		tool_call_id: "tc_test_1",
		name: tool,
		params: { thread_id: "t-dummy" },
	});

	// Block for the tool_result Core writes back on stdin.
	const resultLine = await nextLine();
	const result = JSON.parse(resultLine) as ToolResultLine;

	let outcome: string;
	if (result.kind !== "tool_result" || result.tool_call_id !== "tc_test_1") {
		outcome = "malformed";
	} else if (result.outcome?.ok) {
		const text = result.outcome.ok.content?.[0]?.text ?? "";
		outcome = `ok:${text}`;
	} else if (result.outcome?.err) {
		outcome = `err:${result.outcome.err.code ?? "?"}`;
	} else {
		outcome = "malformed";
	}

	emit({ kind: "text_delta", delta: `tool_outcome=${outcome}` });
	emit({ kind: "done" });
	rl.close();
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
