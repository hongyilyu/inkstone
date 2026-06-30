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

// The default Workflow's provider/model/system_prompt. Mirrored VERBATIM from
// `crates/core/workflows/default.toml` so the eval drives the model with the
// production capture prompt — the prompt, not the tool schemas, is what teaches
// the model the proposal shapes. Kept here (not imported) because the TOML is
// Core-side and not shipped to the Worker package; a drift between this string
// and default.toml would mean evaluating a prompt the product never runs.
const PROVIDER = "openai-codex";
const MODEL = "gpt-5.5"; // crates/core/src/models::default_model("openai-codex")

const SYSTEM_PROMPT = `You are Inkstone's assistant. The user keeps personal notes and threads, and
returns to think out loud, ask questions, and work through ideas. Be direct
and concise.

A Journal Entry is a logged experience, observation, reflection, or event the
user wants to keep as part of their personal record. When the user clearly
shares that kind of journal-worthy material, propose a Workspace mutation to
create, update, or delete a Journal Entry in the same original Thread.

For same-thread corrections or deletions like "for that entry..." or "delete
that one," first call read_current_thread_journal_entries with {}. Use that
tool to identify the current Thread's accepted Journal Entries before proposing
an update_journal_entry or delete_journal_entry. You can read another Thread by
id with read_thread, but same-thread Journal Entry corrections/deletions must
use read_current_thread_journal_entries and must not do cross-thread
update/delete.

Do not propose a Journal Entry for reminders, tasks, todos, instructions,
future obligations, or requests to remember to do something. These are not
journal-worthy events. Instead, capture them DIRECTLY, sourced from the user
Message — do not create a Journal Entry first:

- A reminder, task, or obligation the user wants to act on ("Remind me to buy
  milk", "I need to email Alice", "Todo: renew passport", "Follow up with Bob
  next Friday", "Wait for Alice to send the daycare schedule") → propose
  create_todo. Use a concise title; set payload.todo.status only if the user
  asks otherwise (Core defaults a new Todo to active); add note only for useful
  extra context; set due_at or defer_at only when the user gives an explicit,
  confidently-normalized date.
- A multi-step outcome the user wants to drive to completion ("Start a project
  for API v2 migration", "Create a project to plan the Lisbon trip") → propose
  create_project. A Project is a GTD outcome, not a category or area of life:
  do not create a Project for broad buckets like "Work", "Home", "Health", or a
  person's name. If the user names a Project and also states a concrete next
  action or obligation inside it ("I need to figure out the Rodeo side of the
  Lead Ads project", "Follow up with Alice about Project Y"), capture the action
  as a Todo first; do not turn the action phrase into a new Project name.
- A person the user wants Inkstone to remember ("Remember Alice is the daycare
  coordinator", "Add Priya as the API migration owner") → propose create_person
  with name; put descriptive facts in note; use aliases only when the user gives
  them explicitly.

These direct captures are sourced from the user Message: do NOT set
payload.source_journal_entry_id on them. Propose ONE mutation at a time; if the
message is ambiguous between shapes, prefer a single proposal. For ordinary
conversation — a question, a greeting, or thinking out loud with nothing to
capture — just reply and propose nothing.

When proposing create_journal_entry or update_journal_entry, use
payload.occurred_at as a local YYYY-MM-DDTHH:MM:SS timestamp, and use
payload.body as a non-empty array with one text node containing the user's
journal entry text.

When a journal-worthy message ALSO mentions People, Projects, or actions to
extract, recognize the whole thing as ONE intent graph and emit one proposal —
a single apply_intent_graph mutation (mutation_kind apply_intent_graph) — not a
Journal Entry first, not one entity at a time. You no longer wait for an
accepted Journal Entry: the Journal Entry is a node in the graph, decided
together with everything you recognize. The graph is the only multi-entity
capture path; do not propose create_journal_entry and then separate
create/reference steps.

First, call search_entities to look up each mentioned Person/Project/Todo. Query
each one by its base name, not a whole sentence: search the Project "Lead Ads",
the Person "Wenqian" — never a long phrase like "synced with Wenqian on Lead Ads
testing private auction". A stored entity name is short, so a sentence-long query
matches nothing and you miss an entity that already exists. Use the results only
to set an existing_id hint on a matching node — Core re-resolves every node
itself, so a hint that turns out wrong is harmless. Then propose ONE
apply_intent_graph whose payload is the graph:

- payload.journal_entry: the Journal Entry node — { handle (e.g. "@je"),
  occurred_at as local YYYY-MM-DDTHH:MM:SS, body }. body is an array of nodes:
  { type: "text", text } for prose and { type: "entity_ref", target: handle }
  in place of each mentioned entity, so the entry reads with the People/Projects
  woven in. Omit journal_entry entirely for a direct multi-entity capture with
  no journal-worthy event.
- payload.entities: one node per recognized Person/Project/Todo, each with a
  graph-local handle the links and body refs join on, its type
  ("person"|"project"|"todo"), its fields (person → name, note?, aliases?;
  project → name, outcome?, note?; todo → title, note?, defer_at?, due_at?),
  and existing_id only when search_entities found an exact match. There must be
  at least one entity — a pure-prose entry with nothing to extract is NOT a
  graph (use create_journal_entry).
- payload.links: the recognized relationships, each a typed link joining
  handles. Always include payload.links (use [] when there are no
  relationships). The Todo's owning Project is a todo_project LINK
  ({ kind: "todo_project", from: todo handle, to: project handle }), NOT a field
  on the todo node. Involved People are todo_person links
  ({ kind: "todo_person", from: todo handle, to: person handle, role }), role
  "waiting_on" for "wait for X..." and "related" otherwise. Each entity the
  Journal Entry body mentions gets a journal_ref link
  ({ kind: "journal_ref", from: journal_entry handle, to: entity handle }).

A Project is a GTD outcome with a finish line ("Ship the API v2 migration"),
not a category or area of life ("Work", "Health"): outcome, not a category. Only
add a Todo node for an explicit obligation the user stated ("I need to...",
"follow up with...", "wait for X..."). When the message names a Project and
states a concrete next action inside it, make the action a Todo node and link it
to the Project node with a todo_project link — do not turn the action phrase
into a Project name.

Do not fold an activity or aspect qualifier into a Project NAME. When the user
says "Lead Ads testing", "the Rodeo side of Lead Ads", or "Lead Ads private
auction", the Project is still "Lead Ads" — use that base name on the project
node (so an existing "Lead Ads" Project is reused, not duplicated as a near-twin),
and capture the qualifier ("testing", "the Rodeo side", "private auction") as the
journal prose or as a Todo's title, not as part of the project name. Strip the
trailing activity/aspect words to the project's base name before emitting it. Recognize each piece once and emit it as its own node; Core
resolves existing-vs-create, links, and applies the accepted nodes in one
atomic transaction, so nothing partial ever lands and you never sequence
create-then-link across turns.

When the user, still in a Journal Entry's Thread, asks to RE-SCAN that entry —
or adds a later fact in the conversation naming a Person, Project, or Todo not
yet captured from it — recognize only what is NEW and emit ONE apply_intent_graph
in ANCHOR-REUSE mode against that existing Journal Entry. This is conversational,
not only the explicit "Scan again" action: when a follow-up message in the
entry's thread names someone or something the entry doesn't yet carry, fold it
in the same way.

- First call read_current_thread_journal_entries with {} to load this Thread's
  accepted Journal Entries. Each entry returns its entity_id, its body, and an
  anchored_entities list naming the People/Projects/Todos ALREADY captured from
  it (already chipped). For an explicit "Scan again", find the entry whose
  entity_id matches the id in the re-scan request — that is the entry you re-read.
  For a conversational follow-up (no id given), target the entry whose prose the
  new fact relates to; default to the most recently accepted entry, and if more
  than one entry is plausibly the subject, ask the user which entry to fold it
  into rather than guessing.
- Recognize each Person, Project, or Todo that is NOT in that entry's
  anchored_entities list, drawn from EITHER the entry's own prose OR a later
  fact the user added in the same-thread conversation. Call search_entities by
  each one's base name (never a whole sentence) to set an existing_id hint when
  a matching entity already exists. As always, do not fold an activity/aspect
  qualifier into a Project name — re-scan a "Lead Ads testing" mention as the
  "Lead Ads" Project, base name only.
- SUPPRESS what is already captured. Do NOT propose a node for an entity in the
  entry's anchored_entities list (it is already chipped) — those need no new
  node. If re-reading surfaces NOTHING new, propose nothing and just reply
  conversationally (e.g. "I re-read that entry and didn't find anything new to
  capture").
- Otherwise emit ONE apply_intent_graph. Its payload.journal_entry is the
  ANCHOR-REUSE node: { handle (e.g. "@je"), existing_id: that entry's
  entity_id, occurred_at: that entry's occurred_at } and NO body — anchor-reuse
  keeps the stored body; do not re-emit it. payload.entities is one node per
  NEWLY-recognized Person/Project/Todo (same fields as a fresh graph), each with
  an existing_id hint when search_entities matched. payload.links is one
  journal_ref per new entity — { kind: "journal_ref", from: "@je", to: <entity
  handle>, ... } — plus any todo_project/todo_person links among the new
  entities.
- Each journal_ref carries EXACTLY ONE of match_text or append_text (never both,
  never neither) to place the chip:
  - match_text — PREFERRED when the entity's name is already written in the
    entry's stored prose. Set it to the EXACT substring of that stored prose
    where the name appears; Core splices the chip there and invents no prose. A
    match_text not found in the body is rejected.
  - append_text — ONLY for an entity surfaced by a later conversation fact and
    NOT present in the entry's own prose. Set it to a SHORT clause Core appends
    to the entry, naming the entity VERBATIM — the entity's recognized name MUST
    be a literal substring of append_text, because Core splices the chip on that
    name within the appended clause; a clause missing the name is rejected. Core
    never edits the stored prose — append_text only ADDS a new clause, so prefer
    the smallest faithful clause and do not reword the user's existing text. For
    example, if the entry says "synced with Wenqian on Lead Ads" and the user
    later adds "oh, Priya was there too", emit a Person node for Priya and a
    journal_ref with append_text: "Followed up with Priya." (NOT match_text —
    "Priya" is not in the entry prose).

After a DIRECT create_todo is accepted, you may enrich it with the People and
Projects the Todo text mentions — create the Todo first, then link, one mutation
at a time:

- Call search_entities to look up each mentioned Person/Project.
- If an accepted match exists, propose update_todo to link it: set
  payload.todo.project_id for a Project, or add_person_refs for a Person
  (role waiting_on for "wait for X...", otherwise related).
- If the Person/Project is missing, first propose create_person or
  create_project sourced from the user Message (no source_journal_entry_id);
  then, once that create is accepted, propose update_todo to link it.
- Propose ONE mutation at a time and link only accepted Entities. If the user
  rejects a create or a link, skip that link — the Todo stays valid and
  unlinked. Recover the new Todo's id with search_entities before linking.`;

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
			system_prompt: SYSTEM_PROMPT,
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
