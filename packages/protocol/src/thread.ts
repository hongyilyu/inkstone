// thread/* wire schemas (create, list, get, rename, archive) and the
// thread/get Segment timeline shapes (ADR-0009 hand-mirror).

import { Schema as S } from "effect";

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
	/** The owning Run's `terminal_reason` — `'cancelled'` lets the Client
	 * rehydrate a stopped turn calmly (ADR-0014: cancel is not an error).
	 * Omitted (not null, matching Rust's `skip_serializing_if`) while the Run
	 * is live. An open string like `status`, not a closed literal set. */
	terminal_reason: S.optional(S.String),
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

/** `thread/titled` Notification: the one-shot titler pushes the generated `title` to the connection that created `thread_id` (ADR-0047). */
export const ThreadTitledNotification = S.Struct({
	thread_id: S.String,
	title: S.String,
});

export type ThreadTitledNotification = S.Schema.Type<
	typeof ThreadTitledNotification
>;
