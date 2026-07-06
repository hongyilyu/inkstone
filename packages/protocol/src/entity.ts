// entity/*, journal_entry/rescan, message/search, and recurrence/preview
// wire schemas (ADR-0009 hand-mirror).

import { Schema as S } from "effect";

/** `recurrence/preview` params (ADR-0039 amendment, #227): a draft Recurrence
 * Rule + the editing Todo's current `defer_at`/`due_at`. The editor sends this
 * read-only request to preview where the next occurrence would land. `recurrence`
 * is the opaque rule object (Core's date math validates it via a fail-safe, never
 * rejects here); the dates are optional because a Todo may carry only one anchor.
 * Hand-authored wire params (what Web sends). */
export const RecurrencePreviewParams = S.Struct({
	recurrence: S.Unknown,
	defer_at: S.optional(S.String),
	due_at: S.optional(S.String),
});

export type RecurrencePreviewParams = S.Schema.Type<
	typeof RecurrencePreviewParams
>;

/** `recurrence/preview` result (ADR-0039 amendment, #227): the next occurrence's
 * dates, or `ended: true` when completing the Todo would spawn no successor (end
 * condition reached, or a malformed/partial draft rule). `ended: true` is a normal
 * result, not an error. When `ended` is false, `defer_at`/`due_at` mirror the
 * input's anchor presence; each is omitted (not null) when absent. */
export const RecurrencePreviewResult = S.Struct({
	ended: S.Boolean,
	defer_at: S.optional(S.String),
	due_at: S.optional(S.String),
});

export type RecurrencePreviewResult = S.Schema.Type<
	typeof RecurrencePreviewResult
>;

// entity/* (ADR-0004): the accepted Entities the Library reads; `entity/list` is type-parameterized (one type per call).

/** `entity/list` params: the Entity type to list (one type per call). */
export const EntityListParams = S.Struct({ type: S.String });

export type EntityListParams = S.Schema.Type<typeof EntityListParams>;

export const ResolvedEntityRef = S.Struct({
	id: S.String,
	source_entity_id: S.String,
	target_entity_id: S.String,
	target_entity_type: S.Literal("person", "project", "todo"),
	target_title: S.optional(S.String),
	label_snapshot: S.optional(S.String),
});

export type ResolvedEntityRef = S.Schema.Type<typeof ResolvedEntityRef>;

/**
 * One Todo Person Reference on a Todo `entity/list` row (ADR-0031, ADR-0032):
 * the task-relationship analogue of `refs`. `role` carries the GTD semantics
 * (`waiting_on` ⊇ `related`). Clients derive Project↔Person↔Todo from these.
 */
export const TodoPersonRefView = S.Struct({
	person_id: S.String,
	role: S.Literal("waiting_on", "related"),
});

export type TodoPersonRefView = S.Schema.Type<typeof TodoPersonRefView>;

/**
 * One Entity's origin provenance on an `entity/list` row ("Captured from",
 * ADR-0030). A FLAT optional shape, safe because Core is the sole producer and
 * fills it from one `entity_sources` row whose CHECK guarantees exactly one
 * source kind: a user Message source carries `thread_id` + `thread_title` (link
 * back to the Thread) plus the capturing `message_id` (so the Client can
 * deep-link to the exact message, #184); a Journal-Entry source carries
 * `journal_entry_id` (link to it in the Library). Read `journal_entry_id` first,
 * else the Thread fields (`message_id` rides along with them).
 */
export const EntitySourceView = S.Struct({
	thread_id: S.optional(S.String),
	thread_title: S.optional(S.String),
	message_id: S.optional(S.String),
	journal_entry_id: S.optional(S.String),
});

export type EntitySourceView = S.Schema.Type<typeof EntitySourceView>;

/** One Entity row in an `entity/list` result: the raw tier-2 `entities` columns (ADR-0004). */
export const EntityRow = S.Struct({
	id: S.String,
	type: S.String,
	data: S.Unknown,
	created_at: S.Number,
	updated_at: S.Number,
	refs: S.optional(S.Array(ResolvedEntityRef)),
	/** Present on Todo rows: the Todo's Person References (ADR-0032). */
	person_refs: S.optional(S.Array(TodoPersonRefView)),
	/** The Entity's origin provenance (ADR-0030); absent for a user-authored Entity. */
	source: S.optional(EntitySourceView),
});

export type EntityRow = S.Schema.Type<typeof EntityRow>;

/** `entity/list` result: the accepted Entities of the requested type, newest-first. */
export const EntityListResult = S.Struct({ entities: S.Array(EntityRow) });

export type EntityListResult = S.Schema.Type<typeof EntityListResult>;

/** `entity/backlinks` params (ADR-0050): the Entity whose reverse relations the detail Inspector wants. */
export const EntityBacklinksParams = S.Struct({ entity_id: S.String });

export type EntityBacklinksParams = S.Schema.Type<typeof EntityBacklinksParams>;

/**
 * `entity/backlinks` result (ADR-0050): the two reverse sets Core resolves for the
 * detail Inspector — `mentioned_in` (distinct Journal Entries referencing this
 * Entity) and `linked_todos` (Todos linked via `project_id` / `person_refs`).
 * Both arrays are always present (possibly empty); reuses {@link EntityRow}.
 */
export const EntityBacklinksResult = S.Struct({
	mentioned_in: S.Array(EntityRow),
	linked_todos: S.Array(EntityRow),
});

export type EntityBacklinksResult = S.Schema.Type<typeof EntityBacklinksResult>;

/**
 * `entity/mutate` params (ADR-0033): a user-initiated CRUD request. `payload` is the
 * same discriminated `{mutation_kind, payload}` envelope the Worker's
 * `propose_workspace_mutation` tool uses (minus rationale), so it stays opaque at the
 * wire boundary — Core validates it per `mutation_kind`.
 */
export const EntityMutateParams = S.Struct({
	mutation_kind: S.String,
	payload: S.Unknown,
});

export type EntityMutateParams = S.Schema.Type<typeof EntityMutateParams>;

/** `entity/mutate` result: the affected Entity id — present on create/update, absent on delete. */
export const EntityMutateResult = S.Struct({
	entity_id: S.optional(S.String),
});

export type EntityMutateResult = S.Schema.Type<typeof EntityMutateResult>;

/**
 * `journal_entry/rescan` params (ADR-0042): the Journal Entry to re-scan for
 * people/projects/tasks mentioned but not yet captured. Core resolves the JE's
 * origin Thread and starts an ordinary agent Run there.
 */
export const JournalEntryRescanParams = S.Struct({
	je_id: S.String,
});

export type JournalEntryRescanParams = S.Schema.Type<
	typeof JournalEntryRescanParams
>;

/** `journal_entry/rescan` result: the spawned Run and the origin Thread it runs in (the Client follows `run/subscribe(run_id)` and can navigate to the Thread). */
export const JournalEntryRescanResult = S.Struct({
	run_id: S.String,
	thread_id: S.String,
});

export type JournalEntryRescanResult = S.Schema.Type<
	typeof JournalEntryRescanResult
>;

// message/* (ADR-0035): full-text search over completed Message text, surfaced in ⌘K.

/** One message-search hit (ADR-0035): a completed Message matching the substring query, with a SQL-rendered snippet and its Thread title for navigation. */
export const MessageHit = S.Struct({
	message_id: S.String,
	thread_id: S.String,
	run_id: S.String,
	role: S.Literal("user", "assistant"),
	snippet: S.String,
	thread_title: S.String,
	created_at: S.Number, // ms-epoch
});

export type MessageHit = S.Schema.Type<typeof MessageHit>;

/** `message/search` params (ADR-0035): a substring query over completed message text. */
export const MessageSearchParams = S.Struct({ query: S.String });

export type MessageSearchParams = S.Schema.Type<typeof MessageSearchParams>;

/** `message/search` result: matching hits, newest-first. */
export const MessageSearchResult = S.Struct({ hits: S.Array(MessageHit) });

export type MessageSearchResult = S.Schema.Type<typeof MessageSearchResult>;
