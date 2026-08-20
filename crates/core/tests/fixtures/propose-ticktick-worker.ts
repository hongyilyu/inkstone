// Deterministic park-on-propose fixture for the TickTick WRITE family
// (ticktick-writes W2). Mirrors propose-worker.ts, but emits a
// `propose_ticktick_task` tool_request (the params carry NO mutation_kind —
// the stored kind derives from the tool name).
//
//   - stdin (line 1): the full WorkerManifest JSON (one line).
//   - fresh:  emit one `propose_ticktick_task` tool_request, then BLOCK (Core
//             parks the Run and tears this Worker down).
//   - resume: echo the Decision tool_result's content verbatim as
//             `resume-result=<content>` + `done`, so a test can assert the
//             reconstructed transcript carried the outcome-bearing Decision.
//
// Node builtins ONLY (no npm deps), run standalone via tsx.

import { readFileSync } from "node:fs";
import { emit, type JsonValue, stdinLines } from "./transport.js";

type ProposeManifest = {
	mode?: string;
	messages?: Array<{
		role?: string;
		result?: { content?: Array<{ type?: string; text?: string }> };
	}>;
};

const readProposeParams = (): JsonValue => {
	const paramsFile = process.env.INKSTONE_PROPOSE_PARAMS_FILE;
	if (paramsFile !== undefined && paramsFile.length > 0) {
		return JSON.parse(readFileSync(paramsFile, "utf8"));
	}
	return {
		payload: { title: "buy milk" },
		rationale: "the user asked for a reminder",
	};
};

const main = async (): Promise<void> => {
	const lines = stdinLines();
	const manifestLine = await lines.next();
	if (manifestLine === null) return;

	let manifest: ProposeManifest = {};
	try {
		manifest = JSON.parse(manifestLine);
	} catch {
		// Malformed manifest — fall through to the fresh (propose) path.
	}
	if (manifest.mode === "resume") {
		const toolResult = [...(manifest.messages ?? [])]
			.reverse()
			.find((message) => message.role === "tool_result");
		const text = (toolResult?.result?.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("");
		emit({
			kind: "text_delta",
			delta: `resume-result=${text.length > 0 ? text : "<none>"}`,
		});
		emit({ kind: "done" });
		return;
	}

	emit({
		kind: "tool_request",
		run_id: "",
		tool_call_id: `tc_${process.pid}`,
		name: "propose_ticktick_task",
		params: readProposeParams(),
	});
	// Block forever — Core parks the Run and tears this process down.
	await new Promise<void>(() => {});
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
