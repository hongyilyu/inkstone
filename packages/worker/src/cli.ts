import { WorkerManifest, type RunEvent } from "@inkstone/protocol";
import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import { Effect, Layer, Schema as S } from "effect";
import { createInterface } from "node:readline";
import {
	type InterpreterDeps,
	defaultInterpreterDeps,
	runInterpreter,
} from "./interpreter.js";
import type { CallTool, ToolCallResponse } from "./tool-proxy.js";
import { WorkerTransport } from "./transport.js";

/**
 * The Worker entry point (ADR-0013 stdin transport, ADR-0018 generic
 * interpreter). Reads exactly one NDJSON manifest line from stdin, runs the
 * generic interpreter, and emits Run Events as NDJSON on stdout. There is no
 * per-Workflow code here.
 *
 * Provider deps are chosen by `manifest.workflow.provider`:
 * - `faux` → register pi-ai's faux provider and feed it the canned response
 *   from `INKSTONE_FAUX_RESPONSE` (offline determinism, ADR-0019 as-built).
 * - anything else → {@link defaultInterpreterDeps} (real getModel +
 *   token-injecting streamSimple).
 *
 * Any failure resolving the model or running the loop is converted into a
 * terminal `error` Run Event so a Run never ends without a terminal event
 * (slice-2 review carry #1).
 */

/** Write one NDJSON frame to stdout (Run Events and `tool_request`s). */
const writeLine = (frame: unknown): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const emit = (event: RunEvent): void => {
	writeLine(event);
};

// Inline WorkerTransport (ADR-0027): the Worker binary still emits Run Events
// as NDJSON on stdout, now behind the transport seam. Extracting a formal
// `StdioTransportLive` Layer and converting `main` to `Effect.gen` is slice 3.
const runEventTransport = Layer.succeed(WorkerTransport, { emit });

// Bidirectional stdio (ADR-0013): a single readline over stdin. The FIRST line
// is the manifest; every subsequent line is a `tool_result` Core writes back,
// dispatched to the pending tool call keyed by `tool_call_id`.
const pendingTools = new Map<string, (resp: ToolCallResponse) => void>();
let resolveManifest!: (line: string | null) => void;
const manifestLine = new Promise<string | null>((resolve) => {
	resolveManifest = resolve;
});
let gotManifest = false;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
	if (!gotManifest) {
		gotManifest = true;
		resolveManifest(line);
		return;
	}
	try {
		const msg = JSON.parse(line) as {
			kind?: string;
			tool_call_id?: string;
			outcome?: ToolCallResponse;
		};
		if (msg.kind === "tool_result" && typeof msg.tool_call_id === "string" && msg.outcome) {
			const pending = pendingTools.get(msg.tool_call_id);
			if (pending) {
				pendingTools.delete(msg.tool_call_id);
				pending(msg.outcome);
			}
		}
	} catch {
		// Non-JSON / unknown inbound line: ignore.
	}
});
rl.on("close", () => {
	if (!gotManifest) {
		gotManifest = true;
		resolveManifest(null);
	}
});

/**
 * The production `callTool` (ADR-0018): write a `tool_request` to stdout and
 * resolve when Core writes back the matching `tool_result` on stdin.
 */
const callTool: CallTool = (toolCallId, name, params) =>
	new Promise<ToolCallResponse>((resolve) => {
		pendingTools.set(toolCallId, resolve);
		writeLine({
			kind: "tool_request",
			run_id: "",
			tool_call_id: toolCallId,
			name,
			params,
		});
	});

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

async function main(): Promise<void> {
	const line = await manifestLine;
	if (line === null) {
		// Empty stdin — nothing to run. Mirror the prior worker's exit-0 on
		// no input; Core treats stdout EOF without `done` as a disconnect.
		return;
	}

	let manifest: WorkerManifest;
	try {
		manifest = S.decodeUnknownSync(WorkerManifest)(JSON.parse(line));
	} catch (e) {
		emit({
			kind: "error",
			message: `worker could not parse manifest: ${
				e instanceof Error ? e.message : String(e)
			}`,
		});
		return;
	}

	try {
		// Wire the stdio-backed callTool into the deps so the interpreter's
		// tool proxies (ADR-0018) round-trip through Core. The interpreter is
		// now an Effect that sources `emit` from the provided transport seam.
		await Effect.runPromise(
			runInterpreter(manifest, { ...depsFor(manifest), callTool }).pipe(
				Effect.provide(runEventTransport),
			),
		);
	} catch (e) {
		// runInterpreter normally emits its own terminal event, but an
		// unexpected throw (unknown provider in getModel, loop defect) must
		// still terminate the Run with an error rather than a silent EOF.
		emit({
			kind: "error",
			message: e instanceof Error ? e.message : String(e),
		});
	}
}

main().then(
	() => process.exit(0),
	(e) => {
		// Last-resort guard: emit a terminal error before exiting non-zero.
		try {
			emit({
				kind: "error",
				message: e instanceof Error ? e.message : String(e),
			});
		} catch {
			// stdout already closed; nothing more to do.
		}
		process.exit(1);
	},
);
