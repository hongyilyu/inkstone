// ticktick/* Web-lane wire schemas (external-task-views A2): the connection
// state the Web keys its task query on, and the normalized task rows. Core
// holds no task state — these are computed per read. Hand-mirror of Rust's
// serde shapes in crates/core/src/protocol/ticktick.rs (ADR-0009).

import { Schema as S } from "effect";

/** `ticktick/status` result (A5): a discriminated union on `state`, so
 * "connected" ALWAYS carries the opaque, boot-scoped connection ID and
 * "not_connected" NEVER does — the two illegal shapes (connected-without-id,
 * disconnected-with-id) are unrepresentable. The id is the SOLE task-query key. */
export const TickTickStatusResult = S.Union(
	S.Struct({
		state: S.Literal("connected"),
		connection_id: S.String,
	}),
	S.Struct({ state: S.Literal("not_connected") }),
);

export type TickTickStatusResult = S.Schema.Type<typeof TickTickStatusResult>;

/** A task's single due tuple (S1a: start/due collapse, so no separate start).
 * `date` is TickTick's UTC instant; `is_all_day` + `time_zone` carry the local
 * meaning. Absent on an undated task. */
export const TickTickDue = S.Struct({
	date: S.String,
	is_all_day: S.Boolean,
	time_zone: S.String,
});

export type TickTickDue = S.Schema.Type<typeof TickTickDue>;

/** One checklist sub-item of a CHECKLIST task. */
export const TickTickChecklistItem = S.Struct({
	title: S.String,
	done: S.Boolean,
});

export type TickTickChecklistItem = S.Schema.Type<typeof TickTickChecklistItem>;

/** A normalized TickTick task row for the Web Tasks surface (A2). `list_name`
 * is the resolved list (a `/project` name, `"Inbox"` for the sentinel, or
 * absent = "unnamed list"). Only `TEXT`/`CHECKLIST` kinds reach here. */
export const TickTickTaskRow = S.Struct({
	id: S.String,
	list_name: S.optional(S.String),
	title: S.String,
	kind: S.String,
	priority: S.Number,
	tags: S.Array(S.String),
	due: S.optional(TickTickDue),
	repeat_flag: S.optional(S.String),
	checklist_items: S.Array(TickTickChecklistItem),
});

export type TickTickTaskRow = S.Schema.Type<typeof TickTickTaskRow>;

/** `ticktick/tasks/list` result (A2): the normalized rows plus the truncation
 * signal (`source_limit_reached`, computed on the RAW row count before kind
 * filtering, so it survives NOTE removal). */
export const TickTickTasksListResult = S.Struct({
	tasks: S.Array(TickTickTaskRow),
	source_limit_reached: S.Boolean,
});

export type TickTickTasksListResult = S.Schema.Type<
	typeof TickTickTasksListResult
>;
