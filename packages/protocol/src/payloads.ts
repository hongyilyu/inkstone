// The hand-authored Effect Schema mirror of each agent-proposable Workspace
// mutation's `payload` (ADR-0009's "manually mirrored types + contract tests"
// discipline; promoted into `@inkstone/protocol` so the parity gate guards the
// shipped schema). One entry per wire kind in `schemas`; `parity.test.ts`
// (`tests/contract`) runs each through `JSONSchema.make`, normalizes, and
// asserts deep-equality with the committed Rust fixture (`fixtures/<kind>.json`,
// the schema-of-record).
//
// All 14 wire kinds are authored and registered in `schemas`. `create_todo` is
// the deepest single-entity payload — nested objects 3 levels deep, arrays of
// objects, enums, positive integers, datetime pattern+description, the
// bare-vs-patterned UUID split — so its leaf builders (defined first, below) are
// the shared vocabulary the other kinds reuse. `apply_intent_graph` (ADR-0042)
// is the widest: nested oneOf node-unions for entities, links, and the JE body.

import { Schema as S } from "effect";

// ── Leaf builders that match the Rust `field_spec.rs` dialect ──
//
// `JSONSchema.make` injects a `description` PER refinement (e.g. `minLength(1)`
// → "a string at least 1 character(s) long", `int` → "an integer") — one per
// combinator, not one merged. Passing `{ description: undefined }` as each
// filter's own annotations suppresses its injected description at the source, so
// the only `description` left in the tree is the real LocalDateTime one (rule 4
// in `normalize.ts` then has nothing to strip — `title` is dropped globally).

/** A non-empty string (`FieldSpec::Str { non_empty: true }` → `{minLength:1}`). */
const nonEmptyString = S.String.pipe(
	S.minLength(1, { description: undefined }),
);

/** A positive integer (`FieldSpec::PositiveInt` → `{type:integer, minimum:1}`).
 * Built from `S.Number` (NOT `S.Int`, which hoists a `$ref:"#/$defs/Int"`); a
 * plain number + `int` + `greaterThanOrEqualTo` emits `type:integer` inline. */
const positiveInt = S.Number.pipe(
	S.int({ description: undefined }),
	S.greaterThanOrEqualTo(1, { description: undefined }),
);

/** The local wall-clock datetime field (`FieldSpec::LocalDateTime`): a pattern +
 * the REAL description Rust emits — the one description that must survive
 * normalization (a `descriptor_describes_*` test in Core pins it). */
const localDateTime = S.String.pipe(
	S.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, {
		description: undefined,
	}),
	S.annotations({
		description: "Local wall-clock time in YYYY-MM-DDTHH:MM:SS format.",
	}),
);

/** A UUID advertised WITH the canonical pattern + length (the
 * reference/source/provenance ids, `FieldSpec::Uuid { schema_regex: true }`). */
const patternedUuid = S.String.pipe(
	S.minLength(36, { description: undefined }),
	S.maxLength(36, { description: undefined }),
	S.pattern(
		/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
		{ description: undefined },
	),
);

// ── create_todo sub-schemas (shared leaf builders reused across kinds) ──

/** `recurrence.end` (ADR-0037): an `until` datetime or an `after_count`. */
const recurrenceEnd = S.Struct({
	until: S.optional(localDateTime),
	after_count: S.optional(positiveInt),
});

/** The recurrence cadence units (ADR-0037). The single source the write
 * schema's `unit` literal AND the Web codec's runtime membership check both
 * derive from — previously triplicated (here, `entityCodec.ts`, `recurrence.rs`).
 * `as const` so `S.Literal(...)` emits the same fixed-domain schema. */
export const RECURRENCE_UNITS = [
	"minute",
	"hour",
	"day",
	"week",
	"month",
	"year",
] as const;

/** The recurrence rule (ADR-0037, slimmed by ADR-0039). */
const recurrence = S.Struct({
	interval: positiveInt,
	unit: S.Literal(...RECURRENCE_UNITS),
	anchor: S.Literal("defer_at", "due_at"),
	end: S.optional(recurrenceEnd),
});

/** The TodoData fields OTHER than `title` — already all optional, and identical
 * across both `Mode`s. Spread into the full/partial structs so the two variants
 * differ only in how they declare `title`. */
const todoDataRest = {
	note: S.optional(S.String),
	status: S.optional(S.Literal("active", "completed", "dropped")),
	project_id: S.optional(nonEmptyString),
	defer_at: S.optional(localDateTime),
	due_at: S.optional(localDateTime),
	completed_at: S.optional(localDateTime),
	dropped_at: S.optional(localDateTime),
	recurrence: S.optional(recurrence),
};

/** The TodoData core in `Mode::Full` (create path): `title` required, the rest
 * optional. Exported so the read-data superset gate (`readSchemas.test.ts`) can
 * introspect its field-set independently of the read schema. */
export const todoDataFull = S.Struct({
	title: nonEmptyString,
	...todoDataRest,
});

/** The TodoData core in `Mode::Partial` (`update_todo`'s `todo`): EVERY field
 * optional, `title` included — so the struct emits no `required` array, matching
 * the fixture (a partial update sets only the fields it carries). */
const todoDataPartial = S.Struct({
	title: S.optional(nonEmptyString),
	...todoDataRest,
});

/** One `person_refs` element (ADR-0031): a required `person_id` + optional role. */
const personRef = S.Struct({
	person_id: nonEmptyString,
	role: S.optional(S.Literal("waiting_on", "related")),
});

/** `create_todo` payload: the `todo` envelope + optional Person References +
 * optional provenance id. */
const createTodo = S.Struct({
	todo: todoDataFull,
	person_refs: S.optional(S.Array(personRef)),
	source_journal_entry_id: S.optional(patternedUuid),
});

/** `update_todo` payload (ADR-0031): required `todo_id` (bare) + an optional
 * partial `todo` + the three Person-Reference edit lists — `set`/`add` carry
 * person_ref objects, `remove` carries BARE id strings (the non-empty rule is
 * validator-only). All four lists optional; only the id is required. */
const updateTodo = S.Struct({
	todo_id: S.String,
	todo: S.optional(todoDataPartial),
	set_person_refs: S.optional(S.Array(personRef)),
	add_person_refs: S.optional(S.Array(personRef)),
	remove_person_ids: S.optional(S.Array(S.String)),
});

// ── delete payloads ──
//
// The four deletes (`delete_person` / `delete_project` / `delete_todo`, plus
// `delete_journal_entry`, registered under the journal section below) are the
// identical `{entity_id}` shape: a bare-string id (a UUID at runtime, but
// advertised bare per the dialect — `FieldSpec::Uuid` WITHOUT `schema_regex`,
// like `todo_id`), required. One shared factory, four entries.

/** The shared single-`entity_id` delete payload. */
const deleteByEntityId = S.Struct({
	entity_id: S.String,
});

// ── person payloads (`create_person` / `update_person`) ──
//
// `create`/`update` share the same Person core (name + note + aliases); create
// additionally carries the optional provenance id, update prepends the required
// `entity_id` and drops provenance (the update path has no source entry).

/** The Person core: `name` required (non-empty), `note` optional bare string,
 * `aliases` optional array of BARE strings (the non-empty rule is validator-only,
 * deliberately absent from the schema — the fixture shows plain `{type:string}`
 * items). Spread into both create/update structs so neither duplicates it.
 * Exported for the read-data superset gate (`readSchemas.test.ts`). */
export const personCore = {
	name: nonEmptyString,
	note: S.optional(S.String),
	aliases: S.optional(S.Array(S.String)),
};

/** `create_person`: Person core + optional provenance id. */
const createPerson = S.Struct({
	...personCore,
	source_journal_entry_id: S.optional(patternedUuid),
});

/** `update_person`: required `entity_id` (bare) + Person core. */
const updatePerson = S.Struct({
	entity_id: S.String,
	...personCore,
});

// ── project payloads (`create_project` / `update_project`) ──

/** `project.review_every` (ADR-0036): a positive-int interval + a cadence unit.
 * Both required. (Distinct from the Todo `recurrence` unit — no minute/hour.) */
const reviewEvery = S.Struct({
	interval: positiveInt,
	unit: S.Literal("day", "week", "month", "year"),
});

/** The Project core: `name` required; `outcome`/`note` optional bare strings;
 * `status` optional enum; the six scheduling/review datetimes optional; the
 * `review_every` cadence optional. Spread into create/update (create adds the
 * provenance id, update prepends `entity_id`). Exported for the read-data
 * superset gate (`readSchemas.test.ts`). */
export const projectCore = {
	name: nonEmptyString,
	outcome: S.optional(S.String),
	note: S.optional(S.String),
	status: S.optional(S.Literal("active", "on_hold", "completed", "dropped")),
	defer_at: S.optional(localDateTime),
	due_at: S.optional(localDateTime),
	completed_at: S.optional(localDateTime),
	dropped_at: S.optional(localDateTime),
	next_review_at: S.optional(localDateTime),
	last_reviewed_at: S.optional(localDateTime),
	review_every: S.optional(reviewEvery),
};

/** `create_project`: Project core + optional provenance id. */
const createProject = S.Struct({
	...projectCore,
	source_journal_entry_id: S.optional(patternedUuid),
});

/** `update_project`: required `entity_id` (bare) + Project core. */
const updateProject = S.Struct({
	entity_id: S.String,
	...projectCore,
});

// ── journal body node variants (`BodyPolicy`) ──
//
// A journal `body` is an array (`minItems:1`) of tagged nodes. Each policy
// advertises a different `items.oneOf` (Rust) / `items.anyOf` (Effect, renamed
// by normalize.ts) variant set. The variant array is POSITIONAL — `text_node`
// is FIRST in every policy, matching Rust's emit order; the normalizer never
// sorts the union array, so the `S.Union(...)` members must be declared in that
// same order.

/** The `text` body node — present in EVERY policy, always FIRST. */
const textNode = S.Struct({
	type: S.Literal("text"),
	text: nonEmptyString,
});

/** The `entity_ref` body node carrying an existing-entity `ref_id`
 * (`BodyPolicy::TextOrExistingRef`, `update_journal_entry`). */
const entityRefWithId = S.Struct({
	type: S.Literal("entity_ref"),
	ref_id: nonEmptyString,
});

/** The `entity_ref` PLACEHOLDER node (`BodyPolicy::TextOrNewRef`,
 * `reference_existing_entity_from_journal_entry`): only `type` is required, and
 * the node carries a REAL description Core uses to document the rewrite — a
 * struct-level annotation (NOT a combinator title), so it survives the global
 * `title` strip (rule 3) and must match the Rust fixture verbatim. */
const entityRefPlaceholder = S.Struct({
	type: S.Literal("entity_ref"),
}).annotations({
	description:
		"Placeholder rewritten by Core to the generated or reused EntityRef id.",
});

/** A journal `body`: a non-empty array (`minItems:1`) of the given node
 * variants, text-node first. NOTE: `JSONSchema.make` collapses a 1-element
 * `S.Union(X)` to the bare `X` (no `anyOf` wrapper) — empirically verified — so
 * the single-variant (`create`) body emits bare `text_node` items while Rust
 * emits `oneOf:[text_node]`. normalize.ts reconciles this by renaming `anyOf →
 * oneOf` then unwrapping a single-element `oneOf` symmetrically on both sides. */
const journalBody = (...variants: readonly S.Schema.Any[]) =>
	S.Array(S.Union(...variants)).pipe(S.minItems(1, { description: undefined }));

/** `create_journal_entry` (`BodyPolicy::TextOnly`): required `occurred_at`,
 * optional `ended_at`, required text-only `body`. */
const createJournalEntry = S.Struct({
	occurred_at: localDateTime,
	ended_at: S.optional(localDateTime),
	body: journalBody(textNode),
});

/** `update_journal_entry` (`BodyPolicy::TextOrExistingRef`): required bare
 * `entity_id` + the same timestamps + a `body` whose nodes are text OR an
 * existing-entity ref. */
const updateJournalEntry = S.Struct({
	entity_id: S.String,
	occurred_at: localDateTime,
	ended_at: S.optional(localDateTime),
	body: journalBody(textNode, entityRefWithId),
});

/** `reference_existing_entity_from_journal_entry` (`BodyPolicy::TextOrNewRef`):
 * required patterned source/target ids, optional non-empty `label_snapshot`,
 * and a `body` whose nodes are text OR the entity-ref placeholder. */
const referenceExistingEntityFromJournalEntry = S.Struct({
	source_entity_id: patternedUuid,
	target_entity_id: patternedUuid,
	label_snapshot: S.optional(nonEmptyString),
	body: journalBody(textNode, entityRefPlaceholder),
});

// ── apply_intent_graph payload (ADR-0042) ──
//
// One intent graph: an optional `journal_entry` node, a `minItems:1` array of
// typed entity nodes (person/project/todo), and an array of three link kinds.
// Every node is a tagged object; the entity/link/body arrays are `S.Union(...)`
// of inlined variants → `JSONSchema.make` emits `anyOf` (the normalizer renames
// to `oneOf`), kept POSITIONAL, so members are declared in the SAME order Rust
// emits them (`mutation.rs`): entities person→project→todo; body text→entity_ref;
// links todo_project→todo_person→journal_ref. Each node carries
// `additionalProperties:false` (every Effect `S.Struct` does), matching Rust.
// Deep cross-node validation (handle references, duplicate handles) is the
// resolver's job — NOT advertised here, mirroring the Rust spec.

/** A graph-local handle / handle reference — a non-empty string. */
const handle = nonEmptyString;

/** The optional `existing_id` hint on an entity node (a patterned UUID). */
const intentGraphPersonNode = S.Struct({
	handle,
	type: S.Literal("person"),
	existing_id: S.optional(patternedUuid),
	name: nonEmptyString,
	note: S.optional(S.String),
	aliases: S.optional(S.Array(S.String)),
});

const intentGraphProjectNode = S.Struct({
	handle,
	type: S.Literal("project"),
	existing_id: S.optional(patternedUuid),
	name: nonEmptyString,
	outcome: S.optional(S.String),
	note: S.optional(S.String),
});

const intentGraphTodoNode = S.Struct({
	handle,
	type: S.Literal("todo"),
	existing_id: S.optional(patternedUuid),
	title: nonEmptyString,
	note: S.optional(S.String),
	defer_at: S.optional(localDateTime),
	due_at: S.optional(localDateTime),
});

/** A `journal_entry` body node: text or an `entity_ref` whose `target` is a
 * handle (declared in `entities`). text-node first, matching Rust's emit order. */
const intentGraphBodyTextNode = S.Struct({
	type: S.Literal("text"),
	text: nonEmptyString,
});
const intentGraphBodyEntityRefNode = S.Struct({
	type: S.Literal("entity_ref"),
	target: handle,
});

/** The optional `journal_entry` node (journal-anchored capture). `body` is
 * OPTIONAL: a CREATE node (no `existing_id`) carries the body the fresh entry
 * weaves; an ANCHOR-REUSE node (`existing_id` set — the re-scan path) keeps the
 * existing entry's stored body and re-emits no body. Mirrors the Rust optional
 * `body` on the journal_entry node. */
const intentGraphJournalEntry = S.Struct({
	handle,
	existing_id: S.optional(patternedUuid),
	occurred_at: localDateTime,
	ended_at: S.optional(localDateTime),
	body: S.optional(
		S.Array(
			S.Union(intentGraphBodyTextNode, intentGraphBodyEntityRefNode),
		).pipe(S.minItems(1, { description: undefined })),
	),
});

/** The three link kinds, declared todo_project→todo_person→journal_ref. */
const intentGraphTodoProjectLink = S.Struct({
	kind: S.Literal("todo_project"),
	from: handle,
	to: handle,
});
const intentGraphTodoPersonLink = S.Struct({
	kind: S.Literal("todo_person"),
	from: handle,
	to: handle,
	role: S.Literal("waiting_on", "related"),
});
const intentGraphJournalRefLink = S.Struct({
	kind: S.Literal("journal_ref"),
	from: handle,
	to: handle,
	match_text: S.optional(nonEmptyString),
});

/** `apply_intent_graph` payload: optional `journal_entry`, `>= 1` entity nodes,
 * and the link array (ADR-0042). */
export const applyIntentGraph = S.Struct({
	journal_entry: S.optional(intentGraphJournalEntry),
	entities: S.Array(
		S.Union(intentGraphPersonNode, intentGraphProjectNode, intentGraphTodoNode),
	).pipe(S.minItems(1, { description: undefined })),
	links: S.Array(
		S.Union(
			intentGraphTodoProjectLink,
			intentGraphTodoPersonLink,
			intentGraphJournalRefLink,
		),
	),
});

/** The kind → Effect Schema registry the parity test iterates. All 14 wire
 * kinds are registered here; the test asserts each against its committed
 * `fixtures/<kind>.json`, and `completeness.test.ts` locks this key set to the
 * fixtures dir and the canonical wire-kind list. */
export const schemas = {
	create_todo: createTodo,
	create_person: createPerson,
	update_person: updatePerson,
	create_project: createProject,
	update_project: updateProject,
	update_todo: updateTodo,
	delete_person: deleteByEntityId,
	delete_project: deleteByEntityId,
	delete_todo: deleteByEntityId,
	create_journal_entry: createJournalEntry,
	update_journal_entry: updateJournalEntry,
	delete_journal_entry: deleteByEntityId,
	reference_existing_entity_from_journal_entry:
		referenceExistingEntityFromJournalEntry,
	apply_intent_graph: applyIntentGraph,
} as const satisfies Record<string, S.Schema.Any>;

export type WireKind = keyof typeof schemas;

// ── bookmark payloads (UNGATED — ADR-0036) ──
//
// Bookmark is user-CRUD-only (no agent proposal, no Rust `PayloadSpec`, no
// parity fixture), so its three schemas are NOT registered in `schemas` (that
// would break the 13-kind completeness lock and the parity iteration). They are
// authored here for the Web codec to import directly; the codec's own round-trip
// test is their only guard. Modeled on Person: `title` required non-empty; the
// rest optional bare strings; `tags` an array of BARE strings (the Person
// `aliases` dialect). No `source_journal_entry_id` — bookmarks have no journal
// provenance. `update_bookmark` prepends the required bare `entity_id`;
// `delete_bookmark` reuses the shared `deleteByEntityId` factory.

/** The Bookmark core: `title` required (non-empty), `url`/`note` optional bare
 * strings, `tags` optional array of BARE strings. Spread into create/update so
 * neither duplicates it. */
const bookmarkCore = {
	title: nonEmptyString,
	url: S.optional(S.String),
	note: S.optional(S.String),
	tags: S.optional(S.Array(S.String)),
};

/** `create_bookmark`: Bookmark core (no provenance id). */
export const createBookmark = S.Struct({
	...bookmarkCore,
});

/** `update_bookmark`: required `entity_id` (bare) + Bookmark core. */
export const updateBookmark = S.Struct({
	entity_id: S.String,
	...bookmarkCore,
});

/** `delete_bookmark`: the shared single-`entity_id` delete payload. */
export const deleteBookmark = deleteByEntityId;

// ── read-data schemas (ADR-0009 as-built: read-data schema coverage) ──
//
// The Web codec (`apps/web/src/lib/entityCodec.ts`) decodes a stored Entity's
// opaque `data` blob against these on the way IN. They are deliberately the
// LOOSE twin of the write schemas above: the write side rejects a sparse/legacy
// row (required non-empty `title`/`name`, `additionalProperties:false`), but the
// read side must ACCEPT it — the codec then defaults/coerces (`asString(x) ??
// "Untitled"`, out-of-enum status → "active", partial recurrence → dropped). So
// every field is `S.optional(S.Unknown)`: the schema owns the field-SET (which
// `readSchemas.test.ts` pins as a superset of the write `*_core` field-set, so a
// Rust field-add reds the gate until the read path tracks it), while the codec's
// imperative coercion owns the value TYPES. A tighter field type here would
// REJECT the wrong-typed values the parsers tolerate and reintroduce the very
// blanking the read path guards against.
//
// The key lists below are written by hand, NOT derived from the write cores —
// that independence is the gate's whole point: a new write field must FORCE a
// conscious read-schema edit (and a decision about how the codec reads it), not
// silently auto-appear. Read schemas are open (`onExcessProperty` defaults to
// "ignore"), so an unknown/legacy stored key is tolerated, not rejected.

/** A read-data field: present-or-absent, any stored value (the codec coerces). */
const readField = S.optional(S.Unknown);

/** Relaxed read schema for a stored Todo's `data` (ADR-0031/0037). Superset of
 * `todoDataFull`'s field-set; every field tolerant. */
export const readTodoData = S.Struct({
	title: readField,
	note: readField,
	status: readField,
	project_id: readField,
	defer_at: readField,
	due_at: readField,
	completed_at: readField,
	dropped_at: readField,
	recurrence: readField,
});

/** Relaxed read schema for a stored Person's `data` (ADR-0031). Superset of
 * `personCore`'s field-set. */
export const readPersonData = S.Struct({
	name: readField,
	note: readField,
	aliases: readField,
});

/** Relaxed read schema for a stored Project's `data` (ADR-0031). Superset of
 * `projectCore`'s field-set. The codec additionally carries the whole stored
 * object verbatim onto the view model (for the full-document-replace
 * `update_project`), so an unknown stored key here is intentionally tolerated. */
export const readProjectData = S.Struct({
	name: readField,
	outcome: readField,
	note: readField,
	status: readField,
	defer_at: readField,
	due_at: readField,
	completed_at: readField,
	dropped_at: readField,
	next_review_at: readField,
	last_reviewed_at: readField,
	review_every: readField,
});

/** Relaxed read schema for a stored Bookmark's `data` (ADR-0036). Hand-authored
 * and OUTSIDE the superset gate: bookmark is user-CRUD-only, so Core advertises
 * no `PayloadSpec` and there is no write fixture to pin against. */
export const readBookmarkData = S.Struct({
	title: readField,
	url: readField,
	note: readField,
	tags: readField,
});

/** Relaxed read schema for a stored Journal Entry's `data` (ADR-0030).
 * Hand-authored and OUTSIDE the superset gate: JE's write payload models the
 * write-only `body`/`target` INPUT shape, not the stored read shape, so there is
 * no write-DATA core to derive from. The codec still validates the stored shape
 * strictly (required `occurred_at` pattern, non-empty `body`) and DROPS a row
 * that fails — this schema only bounds the field-SET it reads. */
export const readJournalEntryData = S.Struct({
	occurred_at: readField,
	ended_at: readField,
	body: readField,
});
