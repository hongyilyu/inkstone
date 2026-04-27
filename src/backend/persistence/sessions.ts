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
 * - `findActiveSession`, `loadSession`, `listSessions`, `repairSession`
 *   run on the root client — reads don't take a tx.
 * - `createSession`, `endSession` are session-scope mutators on a
 *   single row — they don't take a tx either; each is atomic by virtue
 *   of being one statement.
 *
 * A session is the root entity; messages + parts + raw AgentMessages
 * hang off it with FK cascades. All top-level ids are UUIDv7 so
 * `ORDER BY id` gives chronological order. Parts use a composite
 * `(message_id, seq)` key — parts don't have cross-session identity.
 *
 * Visibility is agent-scoped: every read path filters on `sessions.agent`.
 */

import type {
	AgentStoreState,
	DisplayMessage,
	DisplayPart,
} from "@bridge/view-model";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import { agentMessages, messages, parts, sessions } from "./db/schema";
import { reportPersistenceError } from "./errors";

export interface SessionRecord {
	id: string;
	agent: string;
	startedAt: number;
	endedAt: number | null;
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

/**
 * Locate the active (`ended_at IS NULL`) session for `agent`. `null` if
 * the agent has no active session. `/clear` marks a session ended
 * without deleting it, so cleared rows are excluded here.
 */
export function findActiveSession(agent: string): SessionRecord | null {
	const db = getDb();
	const rows = db
		.select()
		.from(sessions)
		.where(and(eq(sessions.agent, agent), isNull(sessions.endedAt)))
		.orderBy(desc(sessions.id))
		.limit(1)
		.all();
	const row = rows[0];
	if (!row) return null;
	return {
		id: row.id,
		agent: row.agent,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		title: row.title,
	};
}

export function createSession(init: { agent: string }): SessionRecord {
	const db = getDb();
	const now = Date.now();
	const row = {
		id: newId(),
		startedAt: now,
		endedAt: null,
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
		endedAt: row.endedAt,
		title: row.title,
	};
}

export function endSession(sessionId: string): void {
	const db = getDb();
	try {
		db.update(sessions)
			.set({ endedAt: Date.now() })
			.where(eq(sessions.id, sessionId))
			.run();
	} catch (error) {
		reportPersistenceError({ kind: "session", action: "end", error });
	}
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
 * Repair a session on boot. Strips trailing assistant shells with no
 * parts and no error.
 *
 * Why this still exists after the `message_end` transactional boundary:
 * `message_start` writes the assistant shell *outside* any transaction
 * (the shell's parts + meta + agent_message only land together inside
 * `message_end`'s transaction). A SIGKILL between the shell insert and
 * the `message_end` transaction opening leaves a trailing empty row
 * that `message_end`'s atomicity cannot cover. This call handles that
 * window.
 *
 * Also handles pre-transaction session data from older Inkstone
 * versions (which had per-event implicit transactions).
 *
 * "Trailing" is load-bearing — mid-session empty assistant rows are
 * legitimate (tool-call-only assistant messages with
 * `stopReason: "toolUse"` that render as empty bubbles and are hidden
 * by `msg.parts.length > 0` in the renderer). Only rows newer than the
 * latest non-empty / errored message may be stripped.
 *
 * Implementation: find the latest message id whose bubble has content
 * (non-zero parts OR an error set), then delete every empty assistant
 * with a strictly larger id. One statement, no per-row probe.
 *
 * Best-effort: errors reported, never thrown.
 */
export function repairSession(sessionId: string): void {
	const db = getDb();
	try {
		db.run(sql`
			DELETE FROM messages
			WHERE session_id = ${sessionId}
			  AND role = 'assistant'
			  AND error IS NULL
			  AND NOT EXISTS (
			    SELECT 1 FROM parts p WHERE p.message_id = messages.id
			  )
			  AND id > COALESCE(
			    (SELECT MAX(m2.id) FROM messages m2
			     WHERE m2.session_id = ${sessionId}
			       AND (m2.error IS NOT NULL
			            OR EXISTS (SELECT 1 FROM parts p2 WHERE p2.message_id = m2.id))),
			    ''
			  )
		`);
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: "repair-session",
			error,
		});
	}
}

/**
 * Hydrate everything needed to resume a session. Pure read — call
 * `repairSession(id)` separately before this if you want crash-repair.
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
			endedAt: sess.endedAt,
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
	endedAt: number | null;
	title: string | null;
	messageCount: number;
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

	return rows.map((r) => ({
		id: r.id,
		agent: r.agent,
		startedAt: r.startedAt,
		endedAt: r.endedAt,
		title: r.title,
		messageCount: countBy.get(r.id) ?? 0,
	}));
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

export type StoreSeed = Pick<AgentStoreState, "messages" | "currentAgent">;
