import { Schema as S } from "effect";

import {
	observationEvidence,
	observationRecordDraft,
	recordObservations,
} from "./payloads.js";

export * from "./payloads.js";

export const PostMessageParams = S.Struct({
	thread_id: S.String,
	prompt: S.String,
});
export type PostMessageParams = S.Schema.Type<typeof PostMessageParams>;

export const PostMessageResult = S.Struct({ run_id: S.String });
export type PostMessageResult = S.Schema.Type<typeof PostMessageResult>;

export const SubscribeParams = S.Struct({ run_id: S.String });
export type SubscribeParams = S.Schema.Type<typeof SubscribeParams>;

/** `run/subscribe` result: the Run's `status` at the subscribe instant (ADR-0022 + ADR-0025). */
export const SubscribeResult = S.Struct({
	run_id: S.String,
	status: S.String,
});
export type SubscribeResult = S.Schema.Type<typeof SubscribeResult>;

/** `run/cancel` params: the Run to cancel (ADR-0014). */
export const RunCancelParams = S.Struct({ run_id: S.String });
export type RunCancelParams = S.Schema.Type<typeof RunCancelParams>;

/** `run/cancel` result (ADR-0014): whether Core accepted the cancel command. */
export const RunCancelResult = S.Struct({
	outcome: S.Literal("accepted", "already_terminal", "unknown_run"),
});
export type RunCancelResult = S.Schema.Type<typeof RunCancelResult>;

/** `run/retry` params (ADR-0028 retry amendment, #230): the errored Run to re-drive in place. */
export const RunRetryParams = S.Struct({ run_id: S.String });
export type RunRetryParams = S.Schema.Type<typeof RunRetryParams>;

/** `run/retry` result (ADR-0028 retry amendment, #230): `accepted` (won the
 * `errored → running` flip, now re-driving), `not_errored` (the Run was not
 * errored — a normal response value, not an error frame), or `unknown_run`. */
export const RunRetryResult = S.Struct({
	outcome: S.Literal("accepted", "not_errored", "unknown_run"),
});
export type RunRetryResult = S.Schema.Type<typeof RunRetryResult>;

export const ThreadCreateParams = S.Struct({ prompt: S.String });
export type ThreadCreateParams = S.Schema.Type<typeof ThreadCreateParams>;

export const ThreadCreateResult = S.Struct({
	thread_id: S.String,
	run_id: S.String,
});
export type ThreadCreateResult = S.Schema.Type<typeof ThreadCreateResult>;

export const ThreadSummary = S.Struct({
	id: S.String,
	title: S.String,
	last_activity_at: S.Number,
});
export type ThreadSummary = S.Schema.Type<typeof ThreadSummary>;

export const ThreadListResult = S.Struct({ threads: S.Array(ThreadSummary) });
export type ThreadListResult = S.Schema.Type<typeof ThreadListResult>;

/** `thread/rename` params (ADR-0052): the Thread to rename + its new title.
 * `thread_id` is a bare string here (the gate advertises a string; Core
 * UUID-checks it — the {@link ThreadGetParams} precedent). An empty/whitespace
 * title is rejected by Core, not the schema. */
export const ThreadRenameParams = S.Struct({
	thread_id: S.String,
	title: S.String,
});
export type ThreadRenameParams = S.Schema.Type<typeof ThreadRenameParams>;

/** `thread/archive` params (ADR-0052): the Thread to archive (hide from the
 * default sidebar list). `thread_id` is a bare string (Core UUID-checks it). */
export const ThreadArchiveParams = S.Struct({ thread_id: S.String });
export type ThreadArchiveParams = S.Schema.Type<typeof ThreadArchiveParams>;

/** `thread/unarchive` params (ADR-0052): the Thread to restore to the default
 * list. `thread_id` is a bare string (Core UUID-checks it). */
export const ThreadUnarchiveParams = S.Struct({ thread_id: S.String });
export type ThreadUnarchiveParams = S.Schema.Type<typeof ThreadUnarchiveParams>;

/** The shared ack for the three mutating Thread verbs (`thread/rename`,
 * `thread/archive`, `thread/unarchive`, ADR-0052): the affected `thread_id`.
 * Mirrors {@link EntityMutateResult} but `thread_id` is non-optional — every
 * mutating verb has a target Thread; the Web reconciles by invalidating its
 * `["threads"]` query and re-reading. */
export const ThreadMutateResult = S.Struct({ thread_id: S.String });
export type ThreadMutateResult = S.Schema.Type<typeof ThreadMutateResult>;

/** The seven Run Log milestone kinds (ADR-0028). `run/get_history` surfaces a
 * Run's latest one verbatim — deliberately not folded into the five Run-status
 * values (a resumed-still-working Run reads `proposal_decided`, since `resume`
 * writes no Run Log row). The client owns the kind → label/icon presentation. */
export const RunHistoryKind = S.Literal(
	"running",
	"parked",
	"done",
	"error",
	"cancelled",
	"proposal_pending",
	"proposal_decided",
);
export type RunHistoryKind = S.Schema.Type<typeof RunHistoryKind>;

/** One Run in the `run/get_history` recent-Runs feed (ADR-0028 as-built). `kind`
 * is the latest Run Log milestone; `title` is the owning Thread's title; `at` is
 * the milestone's ms-epoch timestamp (also the recency key). Hand-authored wire
 * struct like {@link ThreadSummary} — NOT a proposable `PayloadSpec` kind, so it
 * sits outside the schema-parity gate (Rust↔TS parity is held by paired tests). */
export const RunHistoryItem = S.Struct({
	run_id: S.String,
	thread_id: S.String,
	title: S.String,
	kind: RunHistoryKind,
	at: S.Number,
});
export type RunHistoryItem = S.Schema.Type<typeof RunHistoryItem>;

/** `run/get_history` params: an optional cap on how many recent Runs to return
 * (Core defaults to 50 when omitted). No cursor — the single-user log (ADR-0007)
 * needs no keyset paging yet. */
export const RunGetHistoryParams = S.Struct({ limit: S.optional(S.Number) });
export type RunGetHistoryParams = S.Schema.Type<typeof RunGetHistoryParams>;

/** `run/get_history` result: recent Runs, newest-first. */
export const RunHistoryResult = S.Struct({ runs: S.Array(RunHistoryItem) });
export type RunHistoryResult = S.Schema.Type<typeof RunHistoryResult>;

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

export const ObservationRecordDraft = observationRecordDraft;
export type ObservationRecordDraft = S.Schema.Type<
	typeof ObservationRecordDraft
>;

export const ObservationEvidence = observationEvidence;
export type ObservationEvidence = S.Schema.Type<typeof ObservationEvidence>;

export const ObservationRecordParams = recordObservations;
export type ObservationRecordParams = S.Schema.Type<
	typeof ObservationRecordParams
>;

export const ObservationRecordResult = S.Struct({
	observation_ids: S.Array(S.String),
});
export type ObservationRecordResult = S.Schema.Type<
	typeof ObservationRecordResult
>;

export const ObservationQueryParams = S.Struct({
	schema_keys: S.optional(S.Array(S.String)),
	from: S.optional(S.String),
	to: S.optional(S.String),
	source_entity_id: S.optional(S.String),
	source_message_id: S.optional(S.String),
	related_entity_id: S.optional(S.String),
	limit: S.optional(S.Number),
});
export type ObservationQueryParams = S.Schema.Type<
	typeof ObservationQueryParams
>;

export const ObservationSourceView = S.Struct({
	source_entity_id: S.optional(S.String),
	source_message_id: S.optional(S.String),
	relation: S.Literal("created_from", "evidenced_by"),
});
export type ObservationSourceView = S.Schema.Type<typeof ObservationSourceView>;

export const ObservationRow = S.Struct({
	id: S.String,
	schema_key: S.String,
	schema_version: S.Number,
	occurred_at: S.String,
	ended_at: S.NullOr(S.String),
	values: S.Unknown,
	note: S.NullOr(S.String),
	source: S.NullOr(ObservationSourceView),
	created_at: S.Number,
	updated_at: S.Number,
});
export type ObservationRow = S.Schema.Type<typeof ObservationRow>;

export const ObservationQueryResult = S.Struct({
	observations: S.Array(ObservationRow),
});
export type ObservationQueryResult = S.Schema.Type<
	typeof ObservationQueryResult
>;

export const ThreadGetParams = S.Struct({ thread_id: S.String });
export type ThreadGetParams = S.Schema.Type<typeof ThreadGetParams>;

/** One item in an assistant turn's ordered `segments[]` timeline (ADR-0045): a
 * contiguous run of text, a tool-activity row, or the decided Proposal — replayed in
 * `run_steps` order so the reload renders the turn's pieces in the order they
 * happened. A `kind`-tagged union mirroring {@link RunEvent}. The variant fields are
 * what each row renders — the former `ToolCallView` (`name`/`status`/optional `arg`,
 * Proposal tool calls excluded) and `MessageProposalView` (`proposal_id`/
 * `mutation_kind`/`status`, decided outcomes only) — inlined under the `kind` tag.
 * The previously-reserved `reasoning` kind (#202) is now realized — the model's
 * thinking renders as a fourth segment kind (see the ADR-0045 reasoning amendment).
 * SUPERSEDES the read-path shapes of ADR-0043 (`tool_calls`) and ADR-0044
 * (`proposal`): both fold into `segments`. */
export const Segment = S.Union(
	S.Struct({ kind: S.Literal("text"), text: S.String }),
	S.Struct({
		kind: S.Literal("tool_call"),
		name: S.String,
		status: S.String,
		arg: S.optional(S.String),
	}),
	S.Struct({
		kind: S.Literal("proposal"),
		proposal_id: S.String,
		mutation_kind: S.String,
		status: S.String,
		/** The durable Entity the accepted change created/updated (ADR-0044
		 * amendment) — the anchor for `apply_intent_graph` — so the decided card can
		 * name + deep-link it. Omitted (not null) for a rejected Proposal (nothing
		 * created) or when no Entity resolves. */
		entity_id: S.optional(S.String),
	}),
	// The model's thinking trace (ADR-0045 reasoning amendment, #202): `text` is the
	// streamed reasoning, `duration_ms` how long the model thought (Core-computed at
	// read, omitted not null when unknown). Renders default-collapsed.
	S.Struct({
		kind: S.Literal("reasoning"),
		text: S.String,
		duration_ms: S.optional(S.Number),
	}),
);
export type Segment = S.Schema.Type<typeof Segment>;

export const MessageView = S.Struct({
	id: S.String,
	role: S.String,
	status: S.String,
	run_id: S.String,
	/** The assistant turn's ordered timeline (ADR-0045) — `text | tool_call |
	 * proposal` items in `run_steps` order — replacing the prior three independent
	 * buckets (`text`, `tool_calls`, `proposal`). A user Message carries a single
	 * `text` segment; the flat reply text is derived via `concatText(segments)`. */
	segments: S.Array(Segment),
});
export type MessageView = S.Schema.Type<typeof MessageView>;

export const ThreadGetResult = S.Struct({
	thread_id: S.String,
	title: S.String,
	messages: S.Array(MessageView),
});
export type ThreadGetResult = S.Schema.Type<typeof ThreadGetResult>;

export const RunEvent = S.Union(
	S.Struct({ kind: S.Literal("text_delta"), delta: S.String }),
	// Core-synthesized, ephemeral tool-call boundary (ADR-0006); `arg` is the
	// tool's display argument (ADR-0043), omitted for argless tools — see docs/design/protocol.md
	S.Struct({
		kind: S.Literal("tool_call"),
		tool_call_id: S.String,
		name: S.String,
		status: S.Literal("started", "completed", "error"),
		arg: S.optional(S.String),
	}),
	S.Struct({ kind: S.Literal("done") }),
	S.Struct({ kind: S.Literal("cancelled") }),
	S.Struct({ kind: S.Literal("error"), message: S.String }),
	// A reasoning (thinking) delta, mirroring `text_delta` (ADR-0045 reasoning
	// amendment, #202): the segment boundary is inferred from the interleaved stream,
	// so no position field — the open reasoning segment opens on the first such delta.
	S.Struct({ kind: S.Literal("reasoning_delta"), delta: S.String }),
);
export type RunEvent = S.Schema.Type<typeof RunEvent>;

// proposal/* (ADR-0025): a Proposal is a Tool Request awaiting a human Decision — see docs/design/protocol.md

/** `proposal/get` params: the parked Run whose pending Proposal to fetch. */
export const ProposalGetParams = S.Struct({ run_id: S.String });
export type ProposalGetParams = S.Schema.Type<typeof ProposalGetParams>;

export const JournalEntryBodyTextNode = S.Struct({
	type: S.Literal("text"),
	text: S.String,
});
export type JournalEntryBodyTextNode = S.Schema.Type<
	typeof JournalEntryBodyTextNode
>;

export const JournalEntryBodyEntityRefNode = S.Struct({
	type: S.Literal("entity_ref"),
	ref_id: S.String,
});
export type JournalEntryBodyEntityRefNode = S.Schema.Type<
	typeof JournalEntryBodyEntityRefNode
>;

export const JournalEntryBodyNode = S.Union(
	JournalEntryBodyTextNode,
	JournalEntryBodyEntityRefNode,
);
export type JournalEntryBodyNode = S.Schema.Type<typeof JournalEntryBodyNode>;

export const ProposalReviewCurrentJournalEntry = S.Struct({
	entity_id: S.String,
	occurred_at: S.String,
	ended_at: S.optional(S.String),
	body: S.Array(JournalEntryBodyNode),
});
export type ProposalReviewCurrentJournalEntry = S.Schema.Type<
	typeof ProposalReviewCurrentJournalEntry
>;

/** The stored Person body surfaced for an `update_person` Proposal's Current
 * section (mirror of {@link ProposalReviewCurrentJournalEntry}). Carries exactly
 * the fields the create/update renderer displays (`renderPersonBody`) — `name`
 * plus optional `note`/`aliases` — so the Client renders Current row-for-row
 * against the Proposed payload, making an omitted (thus removed, per ADR-0033)
 * field visible before accept. Non-identity fields are optional. */
export const ProposalReviewCurrentPerson = S.Struct({
	entity_id: S.String,
	name: S.String,
	note: S.optional(S.String),
	aliases: S.optional(S.Array(S.String)),
});
export type ProposalReviewCurrentPerson = S.Schema.Type<
	typeof ProposalReviewCurrentPerson
>;

/** The stored Project body surfaced for an `update_project` Proposal's Current
 * section (sibling of {@link ProposalReviewCurrentPerson}). Carries the fields
 * `renderProjectBody` displays — `name` plus optional `outcome`/`status`/`note`. */
export const ProposalReviewCurrentProject = S.Struct({
	entity_id: S.String,
	name: S.String,
	outcome: S.optional(S.String),
	status: S.optional(S.String),
	note: S.optional(S.String),
});
export type ProposalReviewCurrentProject = S.Schema.Type<
	typeof ProposalReviewCurrentProject
>;

export const ProposalReviewContext = S.Struct({
	current_journal_entry: S.optional(ProposalReviewCurrentJournalEntry),
	current_person: S.optional(ProposalReviewCurrentPerson),
	current_project: S.optional(ProposalReviewCurrentProject),
});
export type ProposalReviewContext = S.Schema.Type<typeof ProposalReviewContext>;

/** One competing exact match for an `ambiguous` {@link ResolvedNode} (ADR-0042). */
export const ResolvedNodeCandidate = S.Struct({
	entity_id: S.String,
	label: S.String,
});
export type ResolvedNodeCandidate = S.Schema.Type<typeof ResolvedNodeCandidate>;

/** One node of an `apply_intent_graph` proposal's resolved plan (ADR-0042),
 * computed read-only at `proposal/get` so the Client renders create/reuse/
 * ambiguous badges without re-resolving. A FLAT shape keyed by `disposition`:
 * `entity_id` is present only for `reuse`, `candidates` only for `ambiguous`
 * (mirrors the Rust `ResolvedNode`). Advisory — Core re-resolves authoritatively
 * at decide. The JE node is create-only and is NOT a plan node. */
export const ResolvedNode = S.Struct({
	handle: S.String,
	type: S.Literal("person", "project", "todo"),
	disposition: S.Literal("create", "reuse", "ambiguous"),
	label: S.String,
	entity_id: S.optional(S.String),
	candidates: S.optional(S.Array(ResolvedNodeCandidate)),
	/** Advisory near-matches (ADR-0042 near-match amendment): accepted same-type
	 * entities whose name token-overlaps this node's. Present only on a `create`
	 * node with ≥1 overlap; never authority (the apply path stays exact-only). The
	 * Client uses a single near-match to default the node to reuse-that-entity via
	 * the per-node `entity_id` override; 2+ defer to the picker (#181). */
	near_matches: S.optional(S.Array(ResolvedNodeCandidate)),
});
export type ResolvedNode = S.Schema.Type<typeof ResolvedNode>;

/** `proposal/get` result: the Run's pending Proposal. `resolved_plan` is present
 * (per-node create/reuse/ambiguous) only for an `apply_intent_graph` proposal
 * (ADR-0042); omitted for non-graph proposal kinds. */
export const ProposalGetResult = S.Struct({
	proposal_id: S.String,
	run_id: S.String,
	mutation_kind: S.String,
	payload: S.Unknown,
	rationale: S.NullOr(S.String),
	review_context: S.optional(ProposalReviewContext),
	resolved_plan: S.optional(S.Array(ResolvedNode)),
	status: S.String,
});
export type ProposalGetResult = S.Schema.Type<typeof ProposalGetResult>;

/** The closed set of agent-proposable mutation kinds a Proposal can carry
 * (ADR-0018, ADR-0042, ADR-0053). Mirrors `ProposableMutation`
 * (`mutation.rs`) / the `schemas` registry; the Client switches its Proposal
 * rendering on this. */
export const ProposalKind = S.Literal(
	"create_journal_entry",
	"update_journal_entry",
	"delete_journal_entry",
	"reference_existing_entity_from_journal_entry",
	"create_person",
	"update_person",
	"delete_person",
	"create_project",
	"update_project",
	"delete_project",
	"create_todo",
	"update_todo",
	"delete_todo",
	"apply_intent_graph",
	"record_observations",
);
export type ProposalKind = S.Schema.Type<typeof ProposalKind>;

/** One per-node decision in an `apply_intent_graph` decision vector (ADR-0042).
 * Keyed by the graph-local `handle`; `entity_id` overrides a resolved id and
 * `edited_fields` corrects a create-node's content (mutually exclusive per node,
 * accept-only — Core enforces; STRUCT/TYPE only in slice 1, no apply behavior). */
export const NodeDecision = S.Struct({
	handle: S.String,
	decision: S.Literal("accept", "reject"),
	entity_id: S.optional(S.String),
	edited_fields: S.optional(S.Unknown),
});
export type NodeDecision = S.Schema.Type<typeof NodeDecision>;

/** `proposal/decide` params: the user's Decision on a pending Proposal.
 * Non-graph kinds use the scalar `decision` (+ optional `edited_payload`);
 * `apply_intent_graph` (ADR-0042) can also carry a `decisions` vector of
 * per-node decisions keyed by handle. */
export const ProposalDecideParams = S.Struct({
	proposal_id: S.String,
	decision: S.Literal("accept", "reject", "edit"),
	edited_payload: S.optional(S.Unknown),
	decisions: S.optional(S.Array(NodeDecision)),
	decision_idempotency_key: S.optional(S.String),
});
export type ProposalDecideParams = S.Schema.Type<typeof ProposalDecideParams>;

/** `proposal/decide` result: the Proposal's post-decision `status` and any created `entity_id`. */
export const ProposalDecideResult = S.Struct({
	status: S.Literal("accepted", "rejected"),
	entity_id: S.optional(S.String),
});
export type ProposalDecideResult = S.Schema.Type<typeof ProposalDecideResult>;

/** `proposal/pending` Notification: pushed to a Run's subscribers the moment the Run parks (ADR-0025). */
export const ProposalPendingNotification = S.Struct({
	run_id: S.String,
	proposal_id: S.String,
});
export type ProposalPendingNotification = S.Schema.Type<
	typeof ProposalPendingNotification
>;

/** `proposal/changed` Notification: pushed when a pending Proposal is decided (ADR-0025). */
export const ProposalChangedNotification = S.Struct({
	run_id: S.String,
	proposal_id: S.String,
	status: S.Literal("accepted", "rejected"),
});
export type ProposalChangedNotification = S.Schema.Type<
	typeof ProposalChangedNotification
>;

/** `thread/titled` Notification: the one-shot titler pushes the generated `title` to the connection that created `thread_id` (ADR-0047). */
export const ThreadTitledNotification = S.Struct({
	thread_id: S.String,
	title: S.String,
});
export type ThreadTitledNotification = S.Schema.Type<
	typeof ThreadTitledNotification
>;

/** `provider/connected` Notification: Core pushes `{provider}` when the detached credential-drain task persists the rotated OAuth credentials, so the Settings → Models card flips to Connected live without a focus refetch (ADR-0047 second consumer, ADR-0049). */
export const ProviderConnectedNotification = S.Struct({
	provider: S.String,
});
export type ProviderConnectedNotification = S.Schema.Type<
	typeof ProviderConnectedNotification
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

// tool protocol (ADR-0018): the Worker<->Core duplex for tool calls — see docs/design/protocol.md

/** The only `content` modality Core produces today (image is out of scope). */
export const ToolTextContent = S.Struct({
	type: S.Literal("text"),
	text: S.String,
});
export type ToolTextContent = S.Schema.Type<typeof ToolTextContent>;

/** Hand-mirror of pi-agent-core's `AgentToolResult` (ADR-0018:201; no `isError`). */
export const AgentToolResult = S.Struct({
	content: S.Array(ToolTextContent),
	details: S.optional(S.Unknown),
	terminate: S.optional(S.Boolean),
});
export type AgentToolResult = S.Schema.Type<typeof AgentToolResult>;

/** Worker → Core: a request to run a named tool with opaque params. */
export const ToolRequest = S.Struct({
	kind: S.Literal("tool_request"),
	run_id: S.String,
	tool_call_id: S.String,
	name: S.String,
	params: S.Unknown,
});
export type ToolRequest = S.Schema.Type<typeof ToolRequest>;

/** Core → Worker: the outcome of a tool call (success or error). */
export const ToolResult = S.Struct({
	kind: S.Literal("tool_result"),
	run_id: S.String,
	tool_call_id: S.String,
	outcome: S.Union(
		S.Struct({ ok: AgentToolResult }),
		S.Struct({ err: S.Struct({ code: S.String, message: S.String }) }),
	),
});
export type ToolResult = S.Schema.Type<typeof ToolResult>;

/** One tool the Workflow exposes; shipped in the WorkflowManifest. */
export const CoreToolDescriptor = S.Struct({
	name: S.String,
	description: S.String,
	label: S.String,
	json_schema: S.Unknown,
});
export type CoreToolDescriptor = S.Schema.Type<typeof CoreToolDescriptor>;

// What the Worker writes to stdout; reuses `RunEvent`, so its `tool_call`/`cancelled` kinds are never emitted here — see docs/design/protocol.md
export const WorkerOutbound = S.Union(RunEvent, ToolRequest);
export type WorkerOutbound = S.Schema.Type<typeof WorkerOutbound>;

// provider/* (ADR-0023, ADR-0014 amendment): LLM-provider connection.

/** One provider's connection state in `provider/status`. */
export const ProviderStatus = S.Struct({
	id: S.String,
	connected: S.Boolean,
});
export type ProviderStatus = S.Schema.Type<typeof ProviderStatus>;

/** `provider/status` result: connection state of each known provider. */
export const ProviderStatusResult = S.Struct({
	providers: S.Array(ProviderStatus),
});
export type ProviderStatusResult = S.Schema.Type<typeof ProviderStatusResult>;

/** `provider/login_start` params: which provider to begin an OAuth login for. */
export const ProviderLoginStartParams = S.Struct({ provider: S.String });
export type ProviderLoginStartParams = S.Schema.Type<
	typeof ProviderLoginStartParams
>;

/** `provider/login_start` result: the authorize URL to open in a new tab. */
export const ProviderLoginStartResult = S.Struct({ authorize_url: S.String });
export type ProviderLoginStartResult = S.Schema.Type<
	typeof ProviderLoginStartResult
>;

// model/catalog (ADR-0024): the models available per provider, hand-mirrored from pi-ai's MODELS and guarded by a Worker-side drift test.

/** One model in `model/catalog`. `input` is the modality list (`text`/`image`). */
export const ModelInfo = S.Struct({
	id: S.String,
	name: S.String,
	reasoning: S.Boolean,
	input: S.Array(S.String),
});
export type ModelInfo = S.Schema.Type<typeof ModelInfo>;

/** One provider's model group in `model/catalog`. */
export const ProviderModels = S.Struct({
	id: S.String,
	label: S.String,
	models: S.Array(ModelInfo),
});
export type ProviderModels = S.Schema.Type<typeof ProviderModels>;

/** `model/catalog` result: the models available per provider. */
export const ModelCatalogResult = S.Struct({
	providers: S.Array(ProviderModels),
});
export type ModelCatalogResult = S.Schema.Type<typeof ModelCatalogResult>;

// settings/* (ADR-0024): the user's preferred model + global effort.

/** `settings/get` / `settings/set` result: the effective model selection and global effort for the default Workflow. */
export const SettingsResult = S.Struct({
	provider: S.String,
	model: S.NullOr(S.String),
	effort: S.String,
});
export type SettingsResult = S.Schema.Type<typeof SettingsResult>;

/** `settings/set` params: a partial update; an absent field is left unchanged. */
export const SettingsSetParams = S.Struct({
	model: S.optional(S.String),
	effort: S.optional(S.String),
});
export type SettingsSetParams = S.Schema.Type<typeof SettingsSetParams>;

// Worker manifest (ADR-0018 as-built): the spawn payload Core ships to the generic interpreter on stdin — see docs/design/protocol.md

/** One tool call inside an assistant manifest message (ADR-0025 resume). */
export const ManifestToolCall = S.Struct({
	id: S.String,
	name: S.String,
	arguments: S.Unknown,
});
export type ManifestToolCall = S.Schema.Type<typeof ManifestToolCall>;

/** One prior message in the assembled Thread history, a tagged union (ADR-0018 messages[], ADR-0025) — see docs/design/protocol.md */
export const ManifestMessage = S.Union(
	S.Struct({ role: S.Literal("user"), text: S.String }),
	S.Struct({
		role: S.Literal("assistant"),
		text: S.optional(S.String),
		tool_calls: S.optional(S.Array(ManifestToolCall)),
	}),
	S.Struct({
		role: S.Literal("tool_result"),
		tool_call_id: S.String,
		content: S.String,
		is_error: S.optional(S.Boolean),
	}),
);
export type ManifestMessage = S.Schema.Type<typeof ManifestMessage>;

/** The Workflow definition fields the interpreter consumes (ADR-0018). */
export const WorkflowManifest = S.Struct({
	name: S.String,
	version: S.String,
	provider: S.String,
	model: S.String,
	system_prompt: S.String,
	thinking_level: S.Literal("off", "minimal", "low", "medium", "high", "xhigh"),
	tools: S.Array(CoreToolDescriptor),
});
export type WorkflowManifest = S.Schema.Type<typeof WorkflowManifest>;

/** The full spawn manifest written to the Worker's stdin (ADR-0018, ADR-0023, ADR-0025) — see docs/design/protocol.md. `run_id` carries the Run's id in-band so the Worker can stamp its Diagnostic Log (ADR-0038, #146). */
export const WorkerManifest = S.Struct({
	run_id: S.String,
	workflow: WorkflowManifest,
	prompt: S.String,
	messages: S.Array(ManifestMessage),
	mode: S.optional(S.Literal("fresh", "resume")),
	access_token: S.optional(S.String),
});
export type WorkerManifest = S.Schema.Type<typeof WorkerManifest>;
