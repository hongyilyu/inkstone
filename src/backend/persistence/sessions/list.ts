/**
 * Read-only session listing.
 *
 * `listSessions()` returns one row per session for the Ctrl+N session
 * panel: id, agent, startedAt, title, message count, plus a single-line
 * preview derived from the first user message. Visibility is global —
 * the panel renders sessions across every agent and uses `agent` to
 * tint each row.
 *
 * Lives in its own module so the read path doesn't sit alongside the
 * transactional writers in `sessions.ts`. Pure SQL + in-memory
 * post-processing; no `withTransaction`.
 */

import { and, asc, count, desc, eq, inArray, min, ne } from "drizzle-orm";
import { getDb } from "../db/client";
import { messages, parts, sessions } from "../db/schema";

export interface SessionSummary {
	id: string;
	agent: string;
	startedAt: number;
	title: string;
	messageCount: number;
	/**
	 * Single-line preview derived from the session's first user message.
	 * Empty string when the session has no user message yet (it was
	 * created but the prompt failed pre-stream, for example).
	 */
	preview: string;
}

export function listSessions(): SessionSummary[] {
	const db = getDb();
	// Hide router sessions per ADR 0007 / grilling Q16. Router sessions
	// are backend infrastructure (their existence gives the child's
	// `parent_session_id` FK a target and the dispatch tool-call
	// somewhere to live), but the user only ever navigates to the child
	// reader/kb session. The fork-divider in the child carries the
	// routing breadcrumb; the parent row is never user-facing.
	const rows = db
		.select()
		.from(sessions)
		.where(ne(sessions.agent, "router"))
		.orderBy(desc(sessions.id))
		.all();
	if (rows.length === 0) return [];

	const counts = db
		.select({ sessionId: messages.sessionId, n: count() })
		.from(messages)
		.where(
			inArray(
				messages.sessionId,
				rows.map((r) => r.id),
			),
		)
		.groupBy(messages.sessionId)
		.all();
	const countBy = new Map(counts.map((c) => [c.sessionId, c.n]));

	// Preview = concatenation of text parts from each session's first
	// user message. Pre-filter in SQL via `min(messages.id)` per
	// sessionId — UUIDv7's lexical ordering equals chronological order
	// (see docs/SQL.md §Identity model), so `min(id)` is "earliest".
	// The join then hits parts for one message per session instead of
	// all user messages per session.
	//
	// The subquery output is aliased `first_message_id` (not plain
	// `message_id`) so drizzle's unqualified emission in the join
	// predicate — `parts.message_id = message_id` — isn't ambiguous to
	// SQLite. `parts.message_id` exists in the joined table; any alias
	// that doesn't collide with a `parts` column works.
	const firstUserMsgSq = db
		.select({
			sessionId: messages.sessionId,
			firstMessageId: min(messages.id).as("first_message_id"),
		})
		.from(messages)
		.where(
			and(
				eq(messages.role, "user"),
				inArray(
					messages.sessionId,
					rows.map((r) => r.id),
				),
			),
		)
		.groupBy(messages.sessionId)
		.as("first_user_msg");

	const userPartRows = db
		.select({
			sessionId: firstUserMsgSq.sessionId,
			partType: parts.type,
			partText: parts.text,
			partFilename: parts.filename,
		})
		.from(firstUserMsgSq)
		.innerJoin(parts, eq(parts.messageId, firstUserMsgSq.firstMessageId))
		.orderBy(asc(parts.seq))
		.all();

	// Build preview from text parts first; if no text survived (e.g. a
	// `/article`-opened session whose display is short-prose + file-chip
	// only — see `DisplayPart` in bridge/view-model.ts), fall back to
	// the first file part's filename. Matches the "resumed bubble
	// renders identically" invariant: the list row carries the same
	// signal the bubble does when the user opens the session.
	const previewBy = new Map<string, string>();
	const firstFilenameBy = new Map<string, string>();
	for (const row of userPartRows) {
		if (row.partType === "text") {
			const existing = previewBy.get(row.sessionId) ?? "";
			previewBy.set(row.sessionId, existing + row.partText);
		} else if (row.partType === "file" && row.partFilename) {
			if (!firstFilenameBy.has(row.sessionId)) {
				firstFilenameBy.set(row.sessionId, row.partFilename);
			}
		}
	}

	return rows.map((r) => {
		const raw = previewBy.get(r.id) ?? "";
		const textPreview = raw.replace(/\s+/g, " ").trim();
		const preview = textPreview || (firstFilenameBy.get(r.id) ?? "");
		return {
			id: r.id,
			agent: r.agent,
			startedAt: r.startedAt,
			title: r.title,
			messageCount: countBy.get(r.id) ?? 0,
			preview,
		};
	});
}
