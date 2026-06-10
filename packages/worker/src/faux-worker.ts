// =============================================================================
// TEST-ONLY Worker entry — never the production worker command.
//
// This file fakes the LLM provider so Core/e2e integration tests can drive the
// REAL generic interpreter offline and deterministically. It is selected by
// tests via `INKSTONE_WORKER_CMD` (they spawn `tsx .../faux-worker.ts`); it is
// never wired into a shipped build. Production uses `cli.ts`. Reading the
// `INKSTONE_FAUX_*` env vars below is legitimate — this is test code (ADR-0019
// as-built: faux scripting lives at a dedicated test-only entry, off the
// production path).
// =============================================================================

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";
import type { InterpreterDeps } from "./interpreter.js";
import { runWorkerMain } from "./worker-main.js";

/** Flatten a pi message `content` (string | content blocks) to plain text. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) =>
				c && typeof c === "object" && "text" in c
					? String((c as { text: unknown }).text)
					: "",
			)
			.join("");
	}
	return "";
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Build interpreter deps that script pi-ai's faux provider from the
 * `INKSTONE_FAUX_*` env vars, so Core/e2e tests drive the real interpreter
 * offline. This entry is ALWAYS faux (no `provider` guard — `cli.ts` is the
 * production path): every manifest gets a faux provider whose queued
 * response(s) are env-scripted.
 *
 * The five modes (first match wins):
 * - `INKSTONE_FAUX_ERROR` (non-empty)   → a single error message.
 * - `INKSTONE_FAUX_TOOL_CALL === "1"`   → turn 1 `read_thread` on the pasted
 *   thread id, turn 2 echoes the tool result.
 * - `INKSTONE_FAUX_PROPOSE === "1"`     → `propose_workspace_mutation` (fresh) / short
 *   completion (resume), the ADR-0025 park/resume dance.
 * - `INKSTONE_FAUX_ECHO_HISTORY === "1"`→ echo the prior turns' roles+text.
 * - else                                → `INKSTONE_FAUX_RESPONSE` (or a
 *   default) as a plain assistant reply.
 */
export function fauxDepsFor(manifest: WorkerManifest): InterpreterDeps {
	const faux = registerFauxProvider({ provider: "faux" });
	const errorMessage = process.env.INKSTONE_FAUX_ERROR;
	if (errorMessage !== undefined && errorMessage.length > 0) {
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		]);
	} else if (process.env.INKSTONE_FAUX_TOOL_CALL === "1") {
		// Tool-call mode (e2e): turn 1 extracts a thread id from the latest
		// user prompt and calls read_thread; turn 2 echoes the tool result so
		// the assistant's reply reflects the read thread's content. Uses
		// response factories so it reads the live context (the pasted id, then
		// the tool result the proxy round-tripped back).
		faux.setResponses([
			(context) => {
				const lastUser = [...context.messages]
					.reverse()
					.find((m) => m.role === "user");
				const match = textOf(lastUser?.content).match(UUID_RE);
				const threadId = match ? match[0] : "missing";
				return fauxAssistantMessage(
					[fauxToolCall("read_thread", { thread_id: threadId })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const toolResult = [...context.messages]
					.reverse()
					.find((m) => m.role === "toolResult");
				return fauxAssistantMessage(
					`read_thread result: ${textOf(toolResult?.content)}`,
				);
			},
		]);
	} else if (process.env.INKSTONE_FAUX_PROPOSE === "1") {
		// Propose mode (e2e, ADR-0025): the fresh turn calls
		// `propose_workspace_mutation` with a Journal Entry payload, which Core
		// round-trips, persists as a pending Proposal, and PARKS (tearing this
		// Worker down).
		// On resume (`mode:"resume"`) Core re-spawns with the reconstructed
		// transcript ending in the Decision tool_result; the loop continues with
		// a short completion. The faux provider state is per-process, so the
		// resume spawn freshly applies the resume response (mirrors
		// propose-worker.ts at the protocol level).
		if (manifest.mode === "resume") {
			faux.setResponses([fauxAssistantMessage("Done — added it.")]);
		} else {
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("propose_workspace_mutation", {
							mutation_kind: "create_journal_entry",
							payload: {
								occurred_at: "2026-06-10T10:30:00",
								body: [
									{
										type: "text",
										text: "Bought milk after daycare pickup.",
									},
								],
							},
							rationale: "the user shared a journal-worthy moment",
						}),
					],
					{ stopReason: "toolUse" },
				),
			]);
		}
	} else if (process.env.INKSTONE_FAUX_ECHO_HISTORY === "1") {
		// History-echo mode (multi-turn test): reply with the prior messages
		// the loop passed in its context — both roles — so the test can prove
		// Core assembled BOTH the prior user prompt AND the prior assistant
		// reply into the manifest history (the assistant turn is the
		// slice-9 race that this exercises). Uses a response factory so it
		// reads the live context rather than a canned string.
		faux.setResponses([
			(context) => {
				// All prior turns except the current prompt (the last user
				// message). Tag each with its role so the test can assert the
				// assistant turn specifically.
				const prior = context.messages.slice(0, -1);
				const parts = prior.map((m) => `${m.role}=${textOf(m.content)}`);
				return fauxAssistantMessage(`history:${parts.join("|")}`);
			},
		]);
	} else {
		faux.setResponses([
			fauxAssistantMessage(process.env.INKSTONE_FAUX_RESPONSE ?? "faux reply"),
		]);
	}
	return {
		resolveModel: () => faux.getModel(),
		streamFn: streamSimple,
	};
}

// Run only when this file is the process entry (Core/e2e spawn it as
// `tsx .../faux-worker.ts`), NOT when imported — `faux-worker.test.ts` imports
// `fauxDepsFor` to unit-test the dep-builder and must not boot a Worker (which
// would read stdin and `process.exit`). `realpathSync` both sides so the
// macOS `/var`→`/private/var` symlink doesn't defeat the comparison.
const entryPath = process.argv[1];
if (
	entryPath !== undefined &&
	realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url))
) {
	runWorkerMain(fauxDepsFor);
}
