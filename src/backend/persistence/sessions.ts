/**
 * Session store — SQLite-backed persistence for conversations.
 *
 * See `docs/SQL.md` for the authoritative design doc.
 *
 * API contract:
 *
 * - All writers require a transaction handle (`tx`). Callers that don't
 *   need atomicity across multiple writes wrap a single call in
 *   `runInTransaction`. One code path, no optional-tx branching, no
 *   casts. Forces every call site to state intent: "this is atomic /
 *   this runs in isolation."
 * - `loadSession`, `listSessions` run on the root client — reads don't
 *   take a tx.
 * - `createSession` is a session-scope mutator on a single row — it
 *   doesn't take a tx either; it's atomic by virtue of being one
 *   statement.
 *
 * A session is the root entity; messages + parts + raw AgentMessages
 * hang off it with FK cascades. All top-level ids are UUIDv7 so
 * `ORDER BY id` gives chronological order. Parts use a composite
 * `(message_id, seq)` key — parts don't have cross-session identity.
 *
 * Visibility is agent-scoped: every read path filters on `sessions.agent`.
 */

import type { DisplayMessage, DisplayPart } from "@bridge/view-model";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { and, asc, count, desc, eq, inArray, min } from "drizzle-orm";
import { getDb } from "./db/client";
import { agentMessages, messages, parts, sessions } from "./db/schema";
import { reportPersistenceError } from "./errors";

export interface SessionRecord {
	id: string;
	agent: string;
	startedAt: number;
	title: string | null;
}

export interface LoadedSession {
	session: SessionRecord;
	displayMessages: DisplayMessage[];
	agentMessages: AgentMessage[];
}

/**
 * Fresh id. UUIDv7 — the timestamp prefix encodes creation time, so
 * `ORDER BY id` yields approximately-chronological order (tail bits
 * break ms-level ties). `Bun.randomUUIDv7()` is stdlib.
 */
export function newId(): string {
	return Bun.randomUUIDv7();
}

/**
 * Transaction handle. Drizzle's own type is deep + parametric; this
 * alias keeps call-site signatures readable. The capabilities we use
 * (insert/update/delete/select) match the root client exactly, but
 * keeping the two types distinct makes the atomic boundary visible.
 */
export type Tx = Parameters<
	Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

/**
 * Run a synchronous fn inside a single SQLite transaction. Callers that
 * want atomicity across multiple writes call this; callers that want a
 * single atomic write also call this (one-statement variant). All
 * writers in this module require a `tx` parameter — there is no
 * global-client write path, on purpose. See module docstring.
 */
export function runInTransaction<T>(fn: (tx: Tx) => T): T {
	const db = getDb();
	return db.transaction((tx) => fn(tx));
}

export function createSession(init: { agent: string }): SessionRecord {
	const db = getDb();
	const now = Date.now();
	const row = {
		id: newId(),
		startedAt: now,
		agent: init.agent,
		title: null,
	};
	try {
		db.insert(sessions).values(row).run();
	} catch (error) {
		reportPersistenceError({ kind: "session", action: "create", error });
		throw error;
	}
	return {
		id: row.id,
		agent: row.agent,
		startedAt: row.startedAt,
		title: row.title,
	};
}

/**
 * Append a display message header + optionally its parts. `tx` is
 * required. Pass `{ includeParts: false }` at `message_start` — parts
 * stream in and get committed via `finalizeDisplayMessageParts` at
 * `message_end`.
 */
export function appendDisplayMessage(
	tx: Tx,
	sessionId: string,
	msg: DisplayMessage,
	opts?: { includeParts?: boolean },
): void {
	const includeParts = opts?.includeParts ?? true;
	try {
		tx.insert(messages)
			.values({
				id: msg.id,
				sessionId,
				role: msg.role,
				agentName: msg.agentName ?? null,
				modelName: msg.modelName ?? null,
				durationMs: msg.duration ?? null,
				error: msg.error ?? null,
				createdAt: Date.now(),
			})
			.run();

		if (includeParts) {
			for (let i = 0; i < msg.parts.length; i++) {
				const p = msg.parts[i];
				if (!p) continue;
				tx.insert(parts)
					.values({
						messageId: msg.id,
						seq: i,
						type: p.type,
						text: p.text,
					})
					.run();
			}
		}
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: `append-message (${shortId(msg.id)})`,
			error,
		});
	}
}

/** Header-only update (agent/model/duration/error). No parts touch. */
export function updateDisplayMessageMeta(
	tx: Tx,
	_sessionId: string,
	msg: DisplayMessage,
): void {
	try {
		tx.update(messages)
			.set({
				agentName: msg.agentName ?? null,
				modelName: msg.modelName ?? null,
				durationMs: msg.duration ?? null,
				error: msg.error ?? null,
			})
			.where(eq(messages.id, msg.id))
			.run();
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: `update-message (${shortId(msg.id)})`,
			error,
		});
	}
}

/**
 * Flush the final `parts` for a message. DELETE existing parts + batch
 * INSERT the final list. Call once per `message_end`, not per delta.
 */
export function finalizeDisplayMessageParts(
	tx: Tx,
	_sessionId: string,
	msg: DisplayMessage,
): void {
	try {
		tx.delete(parts).where(eq(parts.messageId, msg.id)).run();
		for (let i = 0; i < msg.parts.length; i++) {
			const p = msg.parts[i];
			if (!p) continue;
			tx.insert(parts)
				.values({
					messageId: msg.id,
					seq: i,
					type: p.type,
					text: p.text,
				})
				.run();
		}
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: `finalize-parts (${shortId(msg.id)})`,
			error,
		});
	}
}

/**
 * Append a raw pi-agent-core `AgentMessage`. `displayMessageId` links
 * this row to the `DisplayMessage` it produced (NULL for tool-result /
 * user / custom messages that have no bubble).
 */
export function appendAgentMessage(
	tx: Tx,
	sessionId: string,
	message: AgentMessage,
	opts?: { displayMessageId?: string | null },
): void {
	try {
		tx.insert(agentMessages)
			.values({
				id: newId(),
				sessionId,
				displayMessageId: opts?.displayMessageId ?? null,
				data: message,
			})
			.run();
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: "append-agent-message",
			error,
		});
	}
}

/**
 * Hydrate everything needed to render a past session. Kept for the
 * future `/resume` command — boot no longer auto-resumes, so this
 * function has no runtime caller today but remains the obvious shape
 * for the resume flow when it lands.
 */
export function loadSession(sessionId: string): LoadedSession | null {
	const db = getDb();
	const sessRows = db
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1)
		.all();
	const sess = sessRows[0];
	if (!sess) return null;

	const msgRows = db
		.select()
		.from(messages)
		.where(eq(messages.sessionId, sessionId))
		.orderBy(asc(messages.id))
		.all();

	const messageIds = msgRows.map((m) => m.id);
	const partRows = messageIds.length
		? db.select().from(parts).where(inArray(parts.messageId, messageIds)).all()
		: [];

	const partsByMessage = new Map<string, DisplayPart[]>();
	for (const p of partRows.sort((a, b) => a.seq - b.seq)) {
		const list = partsByMessage.get(p.messageId) ?? [];
		list.push({ type: p.type, text: p.text });
		partsByMessage.set(p.messageId, list);
	}

	const displayMessages: DisplayMessage[] = msgRows.map((m) => ({
		id: m.id,
		role: m.role,
		parts: partsByMessage.get(m.id) ?? [],
		agentName: m.agentName ?? undefined,
		modelName: m.modelName ?? undefined,
		duration: m.durationMs ?? undefined,
		error: m.error ?? undefined,
	}));

	const agentMsgRows = db
		.select()
		.from(agentMessages)
		.where(eq(agentMessages.sessionId, sessionId))
		.orderBy(asc(agentMessages.id))
		.all();

	return {
		session: {
			id: sess.id,
			agent: sess.agent,
			startedAt: sess.startedAt,
			title: sess.title,
		},
		displayMessages,
		agentMessages: agentMsgRows.map((r) => r.data),
	};
}

export interface SessionSummary {
	id: string;
	agent: string;
	startedAt: number;
	title: string | null;
	messageCount: number;
	/**
	 * Single-line preview derived from the session's first user message.
	 * Empty string when the session has no user message yet (it was
	 * created but the prompt failed pre-stream, for example). Used by
	 * the session list panel as a fallback label when `title` is null.
	 */
	preview: string;
}

export function listSessions(agent: string): SessionSummary[] {
	const db = getDb();
	const rows = db
		.select()
		.from(sessions)
		.where(eq(sessions.agent, agent))
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
		})
		.from(firstUserMsgSq)
		.innerJoin(parts, eq(parts.messageId, firstUserMsgSq.firstMessageId))
		.orderBy(asc(parts.seq))
		.all();

	const previewBy = new Map<string, string>();
	for (const row of userPartRows) {
		if (row.partType !== "text") continue;
		const existing = previewBy.get(row.sessionId) ?? "";
		previewBy.set(row.sessionId, existing + row.partText);
	}

	return rows.map((r) => {
		const raw = previewBy.get(r.id) ?? "";
		const preview = raw.replace(/\s+/g, " ").trim();
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

/**
 * Short id for error/log messages. Uses the LAST 8 hex chars (random
 * tail of UUIDv7) — the first 8 are the ms-timestamp prefix and every
 * id written within the same minute shares it, making prefix-based
 * shortening useless for debugging.
 */
function shortId(id: string): string {
	return id.slice(-8);
}
