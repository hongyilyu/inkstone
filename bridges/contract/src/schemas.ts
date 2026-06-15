// The hand-authored Effect Schema mirror of each agent-proposable Workspace
// mutation's `payload` (ADR-0009's "manually mirrored types + contract tests"
// discipline, implemented at the location ADR-0008/0019 name: `bridges/`). One
// entry per wire kind in `schemas`; `parity.test.ts` runs each through
// `JSONSchema.make`, normalizes, and asserts deep-equality with the committed
// Rust fixture (`fixtures/<kind>.json`, the schema-of-record).
//
// Slice 1 authors `create_todo` only — the deepest payload, exercising ~every
// dialect quirk (nested objects 3 levels deep, arrays of objects, enums,
// positive integers, datetime pattern+description, the bare-vs-patterned UUID
// split). Slices 2/3 add the other 12 kinds by extending `schemas`; no Rust
// change is needed because all 13 fixtures are already committed.

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

// ── create_todo sub-schemas (named so slices 2/3 can reuse them) ──

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

/** The TodoData core in `Mode::Full` (create path): `title` required, the rest
 * optional. The `update_todo` partial mode (slice 2) reuses a relaxed variant. */
const todoDataFull = S.Struct({
	title: nonEmptyString,
	note: S.optional(S.String),
	status: S.optional(S.Literal("active", "completed", "dropped")),
	project_id: S.optional(nonEmptyString),
	defer_at: S.optional(localDateTime),
	due_at: S.optional(localDateTime),
	completed_at: S.optional(localDateTime),
	dropped_at: S.optional(localDateTime),
	recurrence: S.optional(recurrence),
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

/** The kind → Effect Schema registry the parity test iterates. Slices 2/3 add
 * the remaining 12 wire kinds here; the test asserts each against its committed
 * `fixtures/<kind>.json`. */
export const schemas = {
	create_todo: createTodo,
} as const satisfies Record<string, S.Schema.Any>;

export type WireKind = keyof typeof schemas;
