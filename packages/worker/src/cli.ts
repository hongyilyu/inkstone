import type { WorkerManifest } from "@inkstone/protocol";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";
import {
	type InterpreterDeps,
	defaultInterpreterDeps,
	runInterpreter,
} from "./interpreter.js";
import { StdioTransportLive } from "./transport-stdio.js";
import { WorkerTransport } from "./transport.js";

/**
 * The Worker entry point (ADR-0013 stdin transport, ADR-0018 generic
 * interpreter, ADR-0027 transport seam). `main` is `Effect.gen` from entry to
 * exit (ADR-0020): it reads the manifest through {@link WorkerTransport}, runs
 * the generic interpreter against the provided transport, and lets the
 * interpreter emit Run Events as NDJSON. The stdio plumbing — readline, the
 * `tool_call_id` correlation map, the stdout writer — lives behind the seam in
 * {@link StdioTransportLive}; there is no per-Workflow code here.
 *
 * Provider deps are chosen by `manifest.workflow.provider`:
 * - `faux` → register pi-ai's faux provider and feed it the canned response
 *   from `INKSTONE_FAUX_RESPONSE` (offline determinism, ADR-0019 as-built).
 * - anything else → {@link defaultInterpreterDeps} (real getModel +
 *   token-injecting streamSimple).
 *
 * Any failure parsing the manifest, resolving the model, or running the loop is
 * converted into a terminal `error` Run Event so a Run never ends without a
 * terminal event (slice-2 review carry #1).
 */

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
 * Build interpreter deps for this manifest. The faux path registers a
 * provider whose single queued response is the env-supplied text (or a
 * faux error when `INKSTONE_FAUX_ERROR` is set), so Core integration tests
 * drive the real interpreter offline.
 */
function depsFor(manifest: WorkerManifest): InterpreterDeps {
	if (manifest.workflow.provider !== "faux") {
		return defaultInterpreterDeps();
	}
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
		// Propose mode (e2e, ADR-0025): the fresh turn calls `propose_entity`
		// with a Todo, which Core round-trips, persists as a pending Proposal,
		// and PARKS (tearing this Worker down). On resume (`mode:"resume"`) Core
		// re-spawns with the reconstructed transcript ending in the Decision
		// tool_result; the loop continues with a short completion. The faux
		// provider state is per-process, so the resume spawn freshly applies the
		// resume response (mirrors propose-worker.ts at the protocol level).
		if (manifest.mode === "resume") {
			faux.setResponses([fauxAssistantMessage("Done — added it.")]);
		} else {
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("propose_entity", {
							type: "todo",
							data: { title: "buy milk", done: false },
							rationale: "the user asked to remember this",
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

// Read the manifest through the seam, then drive the interpreter. Empty stdin
// (`readManifest` → null) is a clean exit with no output; Core treats stdout
// EOF without `done` as a disconnect.
const program = Effect.gen(function* () {
	const transport = yield* WorkerTransport;
	const manifest = yield* transport.readManifest;
	if (manifest === null) return;
	// The interpreter sources both transport channels (`emit` + `callTool`)
	// from the provided seam (ADR-0027); only provider deps are injected.
	yield* runInterpreter(manifest, depsFor(manifest));
});

// A Run never ends without a terminal event: a bad manifest (typed
// ManifestParseError) or an unexpected throw (unknown provider in getModel, a
// loop defect) is converted into a terminal `error` Run Event through the seam.
const main = program.pipe(
	Effect.catchAll((error) =>
		Effect.flatMap(WorkerTransport, (t) =>
			Effect.sync(() => t.emit({ kind: "error", message: error.message })),
		),
	),
	Effect.catchAllDefect((defect) =>
		Effect.flatMap(WorkerTransport, (t) =>
			Effect.sync(() =>
				t.emit({
					kind: "error",
					message: defect instanceof Error ? defect.message : String(defect),
				}),
			),
		),
	),
	Effect.provide(StdioTransportLive),
);

Effect.runPromise(main).then(
	() => process.exit(0),
	// Last resort: the seam already emits the terminal error for every
	// non-catastrophic path above, so a rejection here means stdout itself
	// failed — nothing left to do but exit non-zero.
	() => process.exit(1),
);
