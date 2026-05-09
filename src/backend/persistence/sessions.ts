/**
 * Session store — SQLite-backed persistence for conversations.
 *
 * See `docs/SQL.md` for the authoritative design doc.
 *
 * API contract:
 *
 * - All writers require a transaction handle (`tx`). Production callers
 *   wrap their writes in `persist(writes, opts?)`, which opens a tx via
 *   `withTransaction` and applies one of two error policies depending on
 *   `opts`:
 *     - **No opts** → log-and-continue. Failure is already reported by
 *       the writer; the throw is swallowed so the caller proceeds.
 *     - **`opts.onSuccess`** → persist-first. The follow-up store
 *       mutation only fires on commit, so a failed write leaves the
 *       store at its pre-mutation value.
 *   Tests call `withTransaction` directly to seed fixtures.
 * - Writers report-and-rethrow on failure. `reportPersistenceError` is
 *   idempotent via a per-error sentinel flag, so re-reports of the same
 *   rethrown error up the chain no-op.
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
 * Visibility is global: `listSessions()` returns rows across every agent.
 * Row-level `agent` still lets consumers filter client-side; the resume
 * path in the TUI uses this to swap `Session.selectAgent` when the
 * target session was bound to a different agent.
 */

import type { DisplayMessage, DisplayPart } from "@bridge/view-model";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
import { agentMessages, messages, parts, sessions } from "./db/schema";
import { REPORTED_SENTINEL, reportPersistenceError } from "./errors";
import { repairAlternation } from "./sessions/repair";

export interface SessionRecord {
	id: string;
	agent: string;
	startedAt: number;
	title: string;
}

export interface LoadedSession {
	session: SessionRecord;
	displayMessages: DisplayMessage[];
	agentMessages: AgentMessage[];
	/**
	 * Session-scope rollup of per-turn `AssistantMessage.usage`, summed
	 * across every real (non-synthesized) assistant row on disk. Used to
	 * seed the TUI's `totalTokens` / `totalCost` store on resume so a
	 * reopened session doesn't reset its usage display to zero.
	 *
	 * Aborted turns written by pi-agent-core may carry partial `usage`;
	 * those tokens were really paid for and are included (not a leak).
	 * Synthesized placeholders from the alternation-repair path have no
	 * `usage` field and contribute 0.
	 */
	totals: { tokens: number; cost: number };
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
 * Run a synchronous fn inside a single SQLite transaction. The
 * primitive that `persist` wraps. Production code calls `persist`;
 * `withTransaction` is exposed so tests can seed fixtures and assert
 * on the throws-y path directly.
 *
 * Error contract: the tx body may throw (writers rethrow after reporting
 * via `reportPersistenceError`, which tags the error with the
 * `REPORTED_SENTINEL` flag so this outer catch can dedup). Failures
 * BEFORE the tx body runs — `getDb()` throwing on first use, tx-acquire
 * / SQLITE_BUSY — are caught here and reported as `action: "tx"` so
 * they surface through the toast handler rather than the `console.error`
 * fallback. Rethrows in both cases; callers wrap in `persist` for
 * either log-and-continue or persist-first semantics.
 */
export function withTransaction<T>(fn: (tx: Tx) => T): T {
	try {
		const db = getDb();
		return db.transaction((tx) => fn(tx));
	} catch (error) {
		// Dedup: if a writer already reported this error and rethrew,
		// the sentinel is set. Skip the tx-level report so the user
		// sees one toast per failure, not two. Pre-writer failures
		// (getDb throws, tx-open, SQLITE_BUSY before the body runs)
		// reach here with no sentinel — those get the `action: "tx"`
		// toast so they don't silently fall to `console.error`. Only
		// this one call site reads the sentinel; `reportPersistenceError`
		// itself remains oblivious.
		const alreadyReported =
			error !== null &&
			typeof error === "object" &&
			(error as Record<string, unknown>)[REPORTED_SENTINEL] === true;
		if (!alreadyReported) {
			reportPersistenceError({ kind: "session", action: "tx", error });
			if (error !== null && typeof error === "object") {
				try {
					(error as Record<string, unknown>)[REPORTED_SENTINEL] = true;
				} catch {
					// Frozen / sealed errors (rare) — let the next hop through
					// a future outer catch re-report rather than crashing the
					// reporter.
				}
			}
		}
		throw error;
	}
}

/**
 * Persist `writes` inside a tx. Two policies, picked by `opts`:
 *
 * - **No `opts`** → log-and-continue. Failure is already reported by
 *   the writer (or by `withTransaction`'s outer catch); the throw is
 *   swallowed so the caller proceeds. Used at pre-stream / best-effort
 *   sites (`message_start` shell, tool-result / user AgentMessage,
 *   synthesized-abort loop, synthetic error bubble, `displayMessage`
 *   command helper) where the write is either ephemeral or any drift
 *   is absorbed by load-time repair.
 * - **`opts.onSuccess` present** → persist-first. The follow-up store
 *   mutation only fires on commit — a failed write leaves the store
 *   at its pre-mutation value and matches what `/resume` would
 *   reconstruct from disk. Used at reducer sites that mutate already-
 *   persisted state.
 *
 * Note: `opts` lives at this outer error-policy layer, not on writer
 * signatures — writers still take a required `tx: Tx` per ADR 0012.
 */
export function persist(
	writes: (tx: Tx) => void,
	opts?: { onSuccess?: () => void },
): void {
	try {
		withTransaction(writes);
	} catch {
		return;
	}
	opts?.onSuccess?.();
}

/**
 * Tag an error with the `REPORTED_SENTINEL` flag before rethrowing, so
 * `withTransaction`'s outer catch (and any higher-level tx catch) can
 * dedup. Centralized here so all writer `catch` blocks stay one-liners
 * and the tag-then-rethrow shape is identical across the module.
 * Frozen / primitive errors silently fall through — we accept the
 * occasional double-report rather than making the error reporter itself
 * the new crash site.
 */
function tagReportedAndRethrow(error: unknown): never {
	if (error !== null && typeof error === "object") {
		try {
			(error as Record<string, unknown>)[REPORTED_SENTINEL] = true;
		} catch {
			// noop — see docstring
		}
	}
	throw error;
}

export function createDefaultTitle(startedAt: number): string {
	return `New session - ${new Date(startedAt).toISOString()}`;
}

export function createSession(init: { agent: string }): SessionRecord {
	const db = getDb();
	const now = Date.now();
	const title = createDefaultTitle(now);
	const row = { id: newId(), startedAt: now, agent: init.agent, title };
	try {
		db.insert(sessions).values(row).run();
	} catch (error) {
		reportPersistenceError({ kind: "session", action: "create", error });
		tagReportedAndRethrow(error);
	}
	return {
		id: row.id,
		agent: row.agent,
		startedAt: row.startedAt,
		title: row.title,
	};
}

export function updateSessionTitle(
	tx: Tx,
	sessionId: string,
	title: string,
): void {
	try {
		tx.update(sessions).set({ title }).where(eq(sessions.id, sessionId)).run();
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: `update-session-title (${shortId(sessionId)})`,
			error,
		});
		tagReportedAndRethrow(error);
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
				thinkingLevel: msg.thinkingLevel ?? null,
				error: msg.error ?? null,
				interrupted: msg.interrupted ?? null,
				createdAt: Date.now(),
			})
			.run();

		if (includeParts) {
			for (let i = 0; i < msg.parts.length; i++) {
				const p = msg.parts[i];
				if (!p) continue;
				tx.insert(parts)
					.values(serializePart(msg.id, i, p))
					.run();
			}
		}
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: `append-message (${shortId(msg.id)})`,
			error,
		});
		tagReportedAndRethrow(error);
	}
}

/** Header-only update (agent/model/duration/thinking-level/error/interrupted). No parts touch. */
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
				thinkingLevel: msg.thinkingLevel ?? null,
				error: msg.error ?? null,
				interrupted: msg.interrupted ?? null,
			})
			.where(eq(messages.id, msg.id))
			.run();
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: `update-message (${shortId(msg.id)})`,
			error,
		});
		tagReportedAndRethrow(error);
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
				.values(serializePart(msg.id, i, p))
				.run();
		}
	} catch (error) {
		reportPersistenceError({
			kind: "session",
			action: `finalize-parts (${shortId(msg.id)})`,
			error,
		});
		tagReportedAndRethrow(error);
	}
}

/**
 * Serialize a `DisplayPart` into a row for `parts`. The table's
 * `text` column is NOT NULL — we keep it that way for text/thinking
 * rows and store `""` on file / tool rows, which carry their display
 * data in dedicated columns (`mime`+`filename` for file; `call_id`+
 * `tool_data` for tool). Centralized here so both `appendDisplayMessage`
 * (message_start path) and `finalizeDisplayMessageParts` (message_end
 * path) produce identical rows. Return type is pinned to Drizzle's
 * inferred insert shape so a future column addition to `parts` forces
 * a compile error here rather than at the two distant call sites.
 */
function serializePart(
	messageId: string,
	seq: number,
	p: DisplayPart,
): typeof parts.$inferInsert {
	if (p.type === "file") {
		return {
			messageId,
			seq,
			type: p.type,
			text: "",
			mime: p.mime,
			filename: p.filename,
			callId: null,
			toolData: null,
		};
	}
	if (p.type === "tool") {
		return {
			messageId,
			seq,
			type: p.type,
			text: "",
			mime: null,
			filename: null,
			callId: p.callId,
			toolData: {
				name: p.name,
				args: p.args,
				state: p.state,
				error: p.error,
			},
		};
	}
	if (p.type === "fork") {
		// Fork-marker payload reuses `tool_data` as a generic JSON sidecar.
		// `text` stays empty (fork rows have no body); `call_id` stays NULL
		// (no LLM tool-call ID — this is a synthetic display row per
		// ADR 0015). Anything walking `parts` filtering on
		// `type === "tool"` skips this row by discriminant.
		return {
			messageId,
			seq,
			type: p.type,
			text: "",
			mime: null,
			filename: null,
			callId: null,
			toolData: { parentSessionId: p.parentSessionId },
		};
	}
	return {
		messageId,
		seq,
		type: p.type,
		text: p.text,
		mime: null,
		filename: null,
		callId: null,
		toolData: null,
	};
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
		tagReportedAndRethrow(error);
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
		list.push(deserializePart(p));
		partsByMessage.set(p.messageId, list);
	}

	const displayMessages: DisplayMessage[] = msgRows.map((m) => ({
		id: m.id,
		role: m.role,
		parts: partsByMessage.get(m.id) ?? [],
		agentName: m.agentName ?? undefined,
		modelName: m.modelName ?? undefined,
		duration: m.durationMs ?? undefined,
		// Stored as opaque TEXT; trust the config-layer Zod validation at
		// the write boundary. Pre-stamping rows load as undefined and
		// render without the effort badge.
		thinkingLevel: (m.thinkingLevel as ThinkingLevel | null) ?? undefined,
		error: m.error ?? undefined,
		interrupted: m.interrupted ?? undefined,
	}));

	// Load-time interrupted-user repair. If a user bubble has no real
	// assistant reply following it (no parts, no error, no interrupted
	// flag on the assistant), stamp `interrupted: true` so the renderer
	// shows `[Interrupted by user]` without needing a render-time
	// derivation. Covers sessions interrupted before this stamp was
	// added, and crash-before-`agent_end`-persist scenarios.
	for (let i = 0; i < displayMessages.length; i++) {
		const dm = displayMessages[i];
		if (!dm || dm.role !== "user" || dm.interrupted) continue;
		const next = displayMessages[i + 1];
		const hasRealReply =
			next &&
			next.role === "assistant" &&
			(next.parts.length > 0 || !!next.error || !!next.interrupted);
		if (!hasRealReply) {
			dm.interrupted = true;
		}
	}

	const agentMsgRows = db
		.select()
		.from(agentMessages)
		.where(eq(agentMessages.sessionId, sessionId))
		.orderBy(asc(agentMessages.id))
		.all();

	const agentMessagesOut = agentMsgRows.map((r) => r.data);

	// Sum per-turn usage from real assistant rows on disk. The repair
	// pass below synthesizes placeholders with no `usage` field; we
	// fold over `agentMessagesOut` (pre-repair) so those can't
	// contribute. `cost.total` is typed non-optional by pi-ai but the
	// `?? 0` guards against a provider writing `usage` without a cost
	// breakdown — otherwise `+ undefined` would poison the rollup with
	// NaN. Mirrors the live accumulator in `tui/context/agent.tsx` so
	// a resumed session matches what the original run would have shown.
	let totalTokens = 0;
	let totalCost = 0;
	for (const m of agentMessagesOut) {
		if (m.role === "assistant" && m.usage) {
			totalTokens += m.usage.totalTokens;
			totalCost += m.usage.cost?.total ?? 0;
		}
	}

	// Load-time alternation repair — see `./sessions/repair.ts` for
	// the design doc and invariants. Pure pass over the loaded rows;
	// stored rows are untouched.
	const repaired = repairAlternation(agentMessagesOut);

	return {
		session: {
			id: sess.id,
			agent: sess.agent,
			startedAt: sess.startedAt,
			title: sess.title,
		},
		displayMessages,
		agentMessages: repaired,
		totals: { tokens: totalTokens, cost: totalCost },
	};
}

/**
 * Rehydrate a `DisplayPart` from a row in `parts`. Inverse of
 * `serializePart`. File rows with missing `mime`/`filename` (or tool
 * rows with missing `call_id`/`tool_data`) shouldn't happen under
 * current writers — `serializePart` always populates both — but if
 * corruption is ever observed, report through the persistence error
 * hook and degrade to an empty text part so the session still loads.
 * Loud-but-non-fatal matches the existing posture of other loader
 * defenses (alternation repair, empty-shell pruning).
 *
 * Row type is pinned to Drizzle's `$inferSelect` so a schema column
 * addition forces a compile error here rather than silent drift.
 */
function deserializePart(row: typeof parts.$inferSelect): DisplayPart {
	if (row.type === "file") {
		if (row.mime == null || row.filename == null) {
			reportPersistenceError({
				kind: "session",
				action: `deserialize-part (${shortId(row.messageId)}#${row.seq})`,
				error: new Error(
					`file part missing mime/filename on row (${row.messageId}, ${row.seq})`,
				),
			});
			return { type: "text", text: "" };
		}
		return { type: "file", mime: row.mime, filename: row.filename };
	}
	if (row.type === "tool") {
		// `tool_data` is a JSON column with no runtime validation, so a
		// corrupted row could hold a primitive (string, number) where
		// the schema expects an object. The `in` operator throws
		// TypeError on primitives — gate behind an object-shape check
		// so a single bad row reports + degrades to an empty text part
		// instead of crashing the whole `loadSession` call.
		if (
			row.callId == null ||
			!isToolDataObject(row.toolData) ||
			!("name" in row.toolData)
		) {
			reportPersistenceError({
				kind: "session",
				action: `deserialize-part (${shortId(row.messageId)}#${row.seq})`,
				error: new Error(
					`tool part missing call_id/tool_data on row (${row.messageId}, ${row.seq})`,
				),
			});
			return { type: "text", text: "" };
		}
		return {
			type: "tool",
			callId: row.callId,
			name: row.toolData.name,
			args: row.toolData.args,
			state: row.toolData.state,
			error: row.toolData.error,
		};
	}
	if (row.type === "fork") {
		if (
			!isToolDataObject(row.toolData) ||
			!("parentSessionId" in row.toolData)
		) {
			reportPersistenceError({
				kind: "session",
				action: `deserialize-part (${shortId(row.messageId)}#${row.seq})`,
				error: new Error(
					`fork part missing tool_data.parentSessionId on row (${row.messageId}, ${row.seq})`,
				),
			});
			return { type: "text", text: "" };
		}
		return { type: "fork", parentSessionId: row.toolData.parentSessionId };
	}
	return { type: row.type, text: row.text };
}

/**
 * Object-shape guard for the `tool_data` JSON column. `tool_data` is
 * stored as opaque TEXT and parsed via Drizzle's `mode: "json"` — there's
 * no runtime schema validation, so a malformed row could hold a primitive
 * (`null`, `42`, `"oops"`) or an array. The `in` operator we use to
 * narrow the union throws `TypeError: Cannot use 'in' operator to search
 * for 'X' in <primitive>`, which would surface as a `loadSession` crash
 * instead of the loud-but-non-fatal report path. Excluding arrays too
 * because `parts.toolData` is documented as a record-shaped sidecar.
 */
function isToolDataObject(data: unknown): data is Record<string, unknown> {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}

export { listSessions, type SessionSummary } from "./sessions/list";

/**
 * Short id for error/log messages. Uses the LAST 8 hex chars (random
 * tail of UUIDv7) — the first 8 are the ms-timestamp prefix and every
 * id written within the same minute shares it, making prefix-based
 * shortening useless for debugging.
 */
function shortId(id: string): string {
	return id.slice(-8);
}
