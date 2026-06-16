// The hand-authored Effect Schema mirror of each agent-proposable Workspace
// mutation's `payload` (ADR-0009's "manually mirrored types + contract tests"
// discipline; this contract-test package lives at `tests/contract`). One
// entry per wire kind in `schemas`; `parity.test.ts` runs each through
// `JSONSchema.make`, normalizes, and asserts deep-equality with the committed
// Rust fixture (`fixtures/<kind>.json`, the schema-of-record).
//
// All 13 wire kinds are authored and registered in `schemas`. `create_todo` is
// the deepest payload — nested objects 3 levels deep, arrays of objects, enums,
// positive integers, datetime pattern+description, the bare-vs-patterned UUID
// split — so its leaf builders (defined first, below) are the shared vocabulary
// the other kinds reuse.

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

/** `recurrence.only_on` (ADR-0037): weekday names / month-day integers. */
const recurrenceOnlyOn = S.Struct({
	weekdays: S.optional(
		S.Array(S.Literal("sun", "mon", "tue", "wed", "thu", "fri", "sat")),
	),
	month_days: S.optional(S.Array(positiveInt)),
});

/** `recurrence.end` (ADR-0037): an `until` datetime or an `after_count`. */
const recurrenceEnd = S.Struct({
	until: S.optional(localDateTime),
	after_count: S.optional(positiveInt),
});

/** The recurrence rule (ADR-0037). */
const recurrence = S.Struct({
	interval: positiveInt,
	unit: S.Literal("minute", "hour", "day", "week", "month", "year"),
	schedule: S.Literal("regular", "from_completion"),
	anchor: S.Literal("defer_at", "due_at"),
	catch_up: S.optional(S.Boolean),
	only_on: S.optional(recurrenceOnlyOn),
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
 * optional. */
const todoDataFull = S.Struct({
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
 * items). Spread into both create/update structs so neither duplicates it. */
const personCore = {
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
 * provenance id, update prepends `entity_id`). */
const projectCore = {
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

/** The kind → Effect Schema registry the parity test iterates. All 13 wire
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
} as const satisfies Record<string, S.Schema.Any>;

export type WireKind = keyof typeof schemas;
