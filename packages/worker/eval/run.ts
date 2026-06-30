// The capture-eval RUNNER. Drives Inkstone's REAL interpreter
// (`src/interpreter.ts`) over one fixture and returns the structured proposal
// the model emitted, so the scorer (`score.ts`) can judge it.
//
// Inkstone's Worker drives an LLM that, instead of returning a value, emits its
// proposal as a `propose_workspace_mutation` TOOL CALL through the
// `WorkerTransport.callTool` seam (ADR-0016, ADR-0027). The runner provides an
// eval transport that answers the model's lookup tools from the fixture's
// "world" and CAPTURES the propose call. This is gated by a real provider
// credential — with no token, the runner cannot drive the model (`run.test.ts`
// is `skipIf`-gated so a keyless suite stays green).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import type {
	CoreToolDescriptor,
	RunEvent,
	WorkerManifest,
} from "@inkstone/protocol";
import { Effect, Layer } from "effect";
import { type InterpreterDeps, runInterpreter } from "../src/interpreter.js";
import type { ToolCallResponse } from "../src/tool-proxy.js";
import { WorkerTransport } from "../src/transport.js";
import type { ExistingEntity, Fixture, PredictedProposal } from "./types.js";

const PROVIDER = "openai-codex";
const MODEL = "gpt-5.5"; // crates/core/src/models::default_model("openai-codex")

// The default Workflow's `system_prompt`, READ at runtime from
// `crates/core/workflows/default.toml` — NOT a hand-copy. The prompt (not the
// tool schemas) is what teaches the model the proposal shapes, so the eval must
// drive the SAME prompt the product runs; a hand-copy drifts the day default.toml
// changes. The TOML is Core-side and not bundled into the Worker package, so we
// resolve it from this module's location: `eval/run.ts` sits at
// `packages/worker/eval`, three levels under the repo root that owns `crates/`.
// We walk UP from the module dir looking for `crates/core/workflows/default.toml`
// rather than trusting cwd, so the read works no matter where the eval is invoked.
const DEFAULT_TOML_REL = "crates/core/workflows/default.toml";

function findDefaultToml(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	// Walk up to the filesystem root; stop at the first ancestor that owns the TOML.
	for (;;) {
		const candidate = join(dir, DEFAULT_TOML_REL);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		`loadSystemPrompt: could not locate ${DEFAULT_TOML_REL} walking up from ${fileURLToPath(import.meta.url)}`,
	);
}

/** Read the default Workflow's `system_prompt` from `default.toml`. Extracts the
 * `system_prompt = """ ... """` triple-quoted basic-string block: TOML trims a
 * newline immediately after the opening `"""`, so the content is everything
 * between the open delimiter's trailing newline and the closing `"""`. Cached so
 * repeated calls (per-fixture manifest build + the prompt-hash in `index.ts`)
 * read the file once. */
let cachedPrompt: string | undefined;
export function loadSystemPrompt(): string {
	if (cachedPrompt !== undefined) return cachedPrompt;
	const toml = readFileSync(findDefaultToml(), "utf8");
	const open = toml.indexOf('system_prompt = """');
	if (open === -1) {
		throw new Error(
			'loadSystemPrompt: no `system_prompt = """` in default.toml',
		);
	}
	// Body starts after the opening delimiter and its immediately-following newline
	// (TOML's leading-newline trim rule).
	const bodyStart = toml.indexOf("\n", open) + 1;
	const close = toml.indexOf('"""', bodyStart);
	if (close === -1) {
		throw new Error("loadSystemPrompt: unterminated `system_prompt` block");
	}
	// The closing `"""` sits on its own line; drop the trailing newline before it
	// so the prompt matches the prior verbatim copy (no trailing blank line).
	cachedPrompt = toml.slice(bodyStart, close).replace(/\n$/, "");
	return cachedPrompt;
}

// The four default-Workflow tools (crates/core/workflows/default.toml). The
// runner carries each tool's REAL name/description/label (verbatim from
// crates/core/src/tools/<tool>.rs); the JSON schemas are deliberately permissive
// envelopes, NOT the schemars-derived Draft-07 schemas Core ships at runtime.
// Two reasons the rich schemas are not mirrored here:
//   1. They are generated in Rust (schemars / payload_spec) and would silently
//      drift from a hand-copy.
//   2. The capture behavior is taught by SYSTEM_PROMPT, not the schema — the
//      schema only needs to let the model CALL the tool. Slice 3's scorer
//      validates the emitted payload against the @inkstone/protocol schemas, so
//      schema-validity is measured downstream, not enforced at call time.
const TOOL_DESCRIPTORS: Record<string, CoreToolDescriptor> = {
	read_thread: {
		name: "read_thread",
		description:
			"Read the messages of another thread by its id. Returns the thread's title and its messages in order.",
		label: "Read thread",
		json_schema: {
			type: "object",
			required: ["thread_id"],
			properties: { thread_id: { type: "string" } },
		},
	},
	read_current_thread_journal_entries: {
		name: "read_current_thread_journal_entries",
		description:
			"Read accepted Journal Entries originally created from the current thread, newest revision first.",
		label: "Read current thread journal entries",
		json_schema: { type: "object", properties: {} },
	},
	search_entities: {
		name: "search_entities",
		description:
			"Search accepted People, Projects, Todos, and Habits by type and query; returns compact lookup rows.",
		label: "Search entities",
		json_schema: {
			type: "object",
			required: ["type", "query"],
			properties: {
				type: { type: "string", enum: ["person", "project", "todo", "habit"] },
				query: { type: "string" },
				limit: { type: "integer", minimum: 0 },
			},
		},
	},
	propose_workspace_mutation: {
		name: "propose_workspace_mutation",
		description:
			"Propose a Workspace mutation for user review: capture a journal-worthy lived event or reflection as a Journal Entry, or extract People/Projects/Todos from an already-accepted Journal Entry. Do not create a Journal Entry for a bare reminder, task, or future obligation the user only wants remembered.",
		label: "Propose Workspace mutation",
		// Permissive envelope: { mutation_kind, payload } — the model fills payload
		// per SYSTEM_PROMPT; Core's rich oneOf schema is not mirrored here (see note
		// above). `additionalProperties: true` so the model may attach `rationale`.
		json_schema: {
			type: "object",
			required: ["mutation_kind", "payload"],
			properties: {
				mutation_kind: { type: "string" },
				payload: { type: "object" },
				rationale: { type: ["string", "null"] },
			},
		},
	},
};

/** The default Workflow's tool allowlist, in order (default.toml `tools`). */
const TOOL_ALLOWLIST = [
	"read_thread",
	"read_current_thread_journal_entries",
	"propose_workspace_mutation",
	"search_entities",
] as const;

/** A valid synthetic UUIDv7-shaped run id (mirrors interpreter.test's id). */
const SYNTHETIC_RUN_ID = "01900000-0000-7000-8000-000000000abc";

/** The provider access token the runner authenticates with. The default
 * Workflow's provider (`openai-codex`) is OAuth (ADR-0023): `streamSimple`
 * requires an `apiKey`, which the interpreter injects from
 * `manifest.access_token`. The eval reads that token from the environment — set
 * `INKSTONE_CODEX_ACCESS_TOKEN` to a ChatGPT/Codex access token (the `access`
 * field Core stores in its credential file). No token → `run.test.ts` is
 * `skipIf`-gated and the run is skipped, never failed. */
export const CODEX_ACCESS_TOKEN_ENV = "INKSTONE_CODEX_ACCESS_TOKEN";

/** A `search_entities` result row, in Core's real wire shape (`search_entities`
 * returns `{ "results": [{ id, type, label, aliases? }] }` as a JSON string). */
interface SearchResultRow {
	id: string;
	type: string;
	label: string;
	aliases?: string[];
}

/** Wrap a JSON payload in the `ok` Tool Result shape Core returns: one text
 * content node carrying the stringified payload (mirrors `AgentToolResult`). */
function okResult(payload: unknown): ToolCallResponse {
	return {
		ok: { content: [{ type: "text", text: JSON.stringify(payload) }] },
	};
}

/** Answer a `search_entities` call from the fixture's world: filter by the
 * requested `type` and a case-insensitive `query` substring over each entity's
 * name, returning Core's compact lookup rows. Empty world (or no match) → an
 * empty `results` array. */
function searchWorld(
	world: ExistingEntity[],
	params: unknown,
): ToolCallResponse {
	const { type, query } =
		typeof params === "object" && params !== null
			? (params as { type?: string; query?: string })
			: {};
	const needle = (query ?? "").toLowerCase();
	const results: SearchResultRow[] = world
		.filter(
			(e) =>
				e.type === type &&
				(needle === "" || e.name.toLowerCase().includes(needle)),
		)
		.map((e) => ({ id: e.id, type: e.type, label: e.name }));
	return okResult({ results });
}

/** The eval transport for one fixture. Dispatches `callTool` by NAME (pi assigns
 * tool_call_ids at runtime, so we cannot pre-key by id like InMemoryTransport).
 * It records the captured propose call into `capture.current`, and Run Events
 * into `events`. */
function evalTransport(
	fixture: Fixture,
	events: RunEvent[],
	capture: { current: PredictedProposal | null },
): Layer.Layer<WorkerTransport> {
	return Layer.succeed(WorkerTransport, {
		readManifest: Effect.succeed(null),
		emit: (event) => {
			events.push(event);
		},
		callTool: (_toolCallId, name, params) => {
			switch (name) {
				case "search_entities":
					return Promise.resolve(searchWorld(fixture.world, params));
				case "read_current_thread_journal_entries":
					// The runner has no thread DB; re-scan fixtures would script
					// declared JEs here, but the base case is an empty list.
					return Promise.resolve(okResult({ entries: [] }));
				case "read_thread":
					return Promise.resolve(okResult({ messages: [] }));
				case "propose_workspace_mutation": {
					// CAPTURE the proposal, then return a synthetic accepted result so
					// the model's turn completes without error (a Decision is normally
					// the Tool Result; here we always "accept").
					const obj =
						typeof params === "object" && params !== null
							? (params as { mutation_kind?: unknown; payload?: unknown })
							: {};
					capture.current = {
						mutation_kind: String(obj.mutation_kind ?? ""),
						payload: obj.payload,
					};
					// `terminate: true` ends pi's agent loop after this tool result
					// (`ToolResultOk.terminate`, honored by the proxy and
					// `shouldTerminateToolBatch`). We capture the FIRST proposal and
					// stop the turn: the default capture prompt's create-then-link
					// flow could otherwise drive a SECOND propose call that silently
					// overwrites the captured payload (last-wins). Stopping here makes
					// the eval first-wins and saves a wasted model turn per fixture.
					const accepted = okResult({ status: "accepted" });
					if ("ok" in accepted) accepted.ok.terminate = true;
					return Promise.resolve(accepted);
				}
				default:
					return Promise.reject(
						new Error(`evalTransport: unscripted tool ${name}`),
					);
			}
		},
	});
}

/** Build the spawn manifest for a fixture: the REAL default-Workflow system
 * prompt + provider/model, the four tool descriptors, the fixture message as a
 * fresh prompt, and the env access token. */
function buildManifest(fixture: Fixture): WorkerManifest {
	const accessToken = process.env[CODEX_ACCESS_TOKEN_ENV];
	return {
		run_id: SYNTHETIC_RUN_ID,
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: PROVIDER,
			model: MODEL,
			system_prompt: loadSystemPrompt(),
			thinking_level: "off",
			tools: TOOL_ALLOWLIST.map((name) => TOOL_DESCRIPTORS[name]),
		},
		prompt: fixture.message,
		messages: [],
		mode: "fresh",
		...(accessToken !== undefined ? { access_token: accessToken } : {}),
	};
}

/** Drive the REAL interpreter over `fixture` and return the proposal the model
 * emitted, or `null` if it proposed nothing.
 *
 * Determinism lever: `thinking_level: "off"` (the interpreter omits `reasoning`)
 * plus `temperature: 0` injected through the deps `streamFn` wrapper — the
 * interpreter spreads incoming `options` into `deps.streamFn`, so a temperature
 * set here reaches `streamSimple`. (openai-codex is a reasoning model and may
 * ignore temperature; "off" reasoning is the lever it honors.)
 *
 * `deps` defaults to the real openai-codex model + a temperature-0 `streamSimple`
 * wrapper; tests may inject faux-provider deps to exercise the plumbing without a
 * key. */
export async function runFixture(
	fixture: Fixture,
	deps?: InterpreterDeps,
): Promise<PredictedProposal | null> {
	const resolved: InterpreterDeps = deps ?? {
		resolveModel: () => getModel(PROVIDER as never, MODEL as never),
		streamFn: ((model, context, options) =>
			streamSimple(model, context, {
				...options,
				temperature: 0,
			})) as StreamFn,
	};

	const manifest = buildManifest(fixture);
	const events: RunEvent[] = [];
	const capture: { current: PredictedProposal | null } = { current: null };

	await Effect.runPromise(
		runInterpreter(manifest, resolved).pipe(
			Effect.provide(evalTransport(fixture, events, capture)),
		),
	);

	return capture.current;
}
