// proposal/* wire schemas (get, decide, notifications) and the resolved-plan
// review shapes (ADR-0009 hand-mirror).

import { Schema as S } from "effect";

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
