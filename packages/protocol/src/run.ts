// run/* wire schemas (post_message, subscribe, cancel, retry, get_history)
// plus the streaming RunEvent union they carry (ADR-0009 hand-mirror).

import { Schema as S } from "effect";

/** `run/post_message` params: the target Thread + `prompt`, plus optional
 * `attachment_ids` — ids from prior `media/upload` calls to link to the user
 * Message (ADR-0058); omitted = no attachments. */
export const PostMessageParams = S.Struct({
	thread_id: S.String,
	prompt: S.String,
	attachment_ids: S.optional(S.Array(S.String)),
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

/** The Run Events the Worker itself emits: streaming deltas plus one terminal
 * `done`/`error` (the Worker half of Rust's `WorkerStdout`). */
export const WorkerRunEvent = S.Union(
	S.Struct({ kind: S.Literal("text_delta"), delta: S.String }),
	// A reasoning (thinking) delta, mirroring `text_delta` (ADR-0045 reasoning
	// amendment, #202): the segment boundary is inferred from the interleaved stream,
	// so no position field — the open reasoning segment opens on the first such delta.
	S.Struct({ kind: S.Literal("reasoning_delta"), delta: S.String }),
	S.Struct({ kind: S.Literal("done") }),
	S.Struct({ kind: S.Literal("error"), message: S.String }),
);

export type WorkerRunEvent = S.Schema.Type<typeof WorkerRunEvent>;

/** The full stream the Client subscribes to: the Worker-emitted events plus the
 * two kinds only Core synthesizes. */
export const RunEvent = S.Union(
	...WorkerRunEvent.members,
	// Core-synthesized, ephemeral tool-call boundary (ADR-0006); `arg` is the
	// tool's display argument (ADR-0043), omitted for argless tools — see docs/design/protocol.md
	S.Struct({
		kind: S.Literal("tool_call"),
		tool_call_id: S.String,
		name: S.String,
		status: S.Literal("started", "completed", "error"),
		arg: S.optional(S.String),
	}),
	S.Struct({ kind: S.Literal("cancelled") }),
);

export type RunEvent = S.Schema.Type<typeof RunEvent>;
