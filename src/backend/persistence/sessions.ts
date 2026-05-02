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
 * - Writers report-and-rethrow on failure. `reportPersistenceError` is
 *   idempotent via a per-error sentinel flag, so re-reports of the same
 *   rethrown error up the chain no-op. Callers that want "log and
 *   continue" wrap in `safeRun`; callers that want "log then gate
 *   follow-up work on success" use `persistThen` in the reducer.
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
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { and, asc, count, desc, eq, inArray, min } from "drizzle-orm";
import { getDb } from "./db/client";
import { agentMessages, messages, parts, sessions } from "./db/schema";
import { REPORTED_SENTINEL, reportPersistenceError } from "./errors";

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
 * Run a synchronous fn inside a single SQLite transaction. Callers that
 * want atomicity across multiple writes call this; callers that want a
 * single atomic write also call this (one-statement variant). All
 * writers in this module require a `tx` parameter — there is no
 * global-client write path, on purpose. See module docstring.
 *
 * Error contract: the tx body may throw (writers rethrow after reporting
 * via `reportPersistenceError`, which tags the error with the
 * `REPORTED_SENTINEL` flag so this outer catch can dedup). Failures
 * BEFORE the tx body runs — `getDb()` throwing on first use, tx-acquire
 * / SQLITE_BUSY — are caught here and reported as `action: "tx"` so
 * they surface through the toast handler rather than the `console.error`
 * fallback. Rethrows in both cases; callers that want "log and continue"
 * wrap in `safeRun`, callers that want "log then gate follow-up work"
 * use `persistThen` (in the reducer).
 */
export function runInTransaction<T>(fn: (tx: Tx) => T): T {
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
 * Swallow persistence failures after they've already been reported.
 * Used at the 6 non-reducer persist sites (message_start shell,
 * tool-result / user AgentMessage, synthesized-abort loop, synthetic
 * error bubble, `displayMessage` command helper) where there is no
 * in-memory state to keep in sync with the write — losing the write is
 * a drift between store and disk, but that drift is either benign
 * (ephemeral shell) or absorbed by load-time repair. The reducer sites
 * that DO have store state to gate use `persistThen` in the TUI layer
 * instead.
 *
 * `fn` is expected to wrap a `runInTransaction` call (or a writer call
 * that throws). The throw has already produced a toast via
 * `reportPersistenceError`.
 */
export function safeRun(fn: () => void): void {
	try {
		fn();
	} catch {
		// Already reported by the writer or by runInTransaction's outer
		// catch. Swallow to preserve "log and continue" semantics.
	}
}

/**
 * Tag an error with the `REPORTED_SENTINEL` flag before rethrowing, so
 * `runInTransaction`'s outer catch (and any higher-level tx catch) can
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
		tagReportedAndRethrow(error);
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

	// Load-time alternation repair. Two classes of corruption can end up
	// on disk when a stream is killed mid-turn (Ctrl+C / process crash
	// between `message_start` and `message_end`):
	//
	//   (a) TAIL ORPHAN — the interrupted turn was the last one in the
	//       session. `agent_messages` ends with a lone `user` row.
	//   (b) INTERIOR GAP — the interrupted turn was followed by a
	//       successful later turn after resume. `agent_messages` has
	//       two adjacent `user` rows with no assistant between them
	//       (first user's reply never committed; second user is the
	//       post-resume prompt).
	//
	// Both shapes hand the provider consecutive user turns on the next
	// prompt: Anthropic silently merges them, Bedrock 400s on
	// `ValidationException`. Synthesize a closing assistant placeholder
	// between every adjacent `user`/`user` pair AND after a trailing
	// `user`, so `agent.state.messages` alternates cleanly. Placeholder
	// never reaches a provider — it only fills the alternation slot in
	// `state.messages`. Stored rows are untouched (pure read-time
	// repair).
	//
	// Alternation is evaluated against the last `user | assistant` role
	// in `repaired` — NOT the direct neighbor — so `toolResult` /
	// `custom` rows between two `user`s don't mask the gap. Without
	// this, `[user, toolResult, user]` (post-tool crash between the
	// second assistant's `message_start` and `message_end`) would
	// escape repair and trip Bedrock 400 on the next prompt.
	//
	// Metadata sourcing: latest prior assistant's `api`/`provider`/
	// `model`, **excluding** synthesized placeholders (identified by
	// the distinctive `stopReason: "aborted"` + `errorMessage:
	// "[Interrupted by user]"` pair). Without this skip, sequential
	// dangling gaps compound — the second placeholder would inherit
	// `model: "placeholder"` from the first. `agent.state.messages`
	// only uses these fields to round-trip through `convertToLlm` for
	// non-tail assistants; real aborted-user bubbles happen to match
	// the same skip predicate but their metadata would propagate
	// correctly anyway (same provider/model), so the widening is
	// harmless — documented as accepted behavior in docs/TODO.md.
	const repaired: AgentMessage[] = [];
	for (const msg of agentMessagesOut) {
		if (lastAlternationRole(repaired) === "user" && msg.role === "user") {
			const priorAssistant = findLatestRealAssistant(repaired);
			repaired.push(buildAbortedAssistant(priorAssistant));
		}
		repaired.push(msg);
	}
	if (lastAlternationRole(repaired) === "user") {
		const priorAssistant = findLatestRealAssistant(repaired);
		repaired.push(buildAbortedAssistant(priorAssistant));
	}

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
		if (row.callId == null || row.toolData == null) {
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
	return { type: row.type, text: row.text };
}

/**
 * Role of the last alternation-relevant message (`user | assistant`),
 * skipping `toolResult` / `custom` rows that sit between a user turn
 * and its closing assistant. Used by the load-time repair so a
 * `toolResult` doesn't mask a `[user, user]` gap.
 */
function lastAlternationRole(
	list: AgentMessage[],
): "user" | "assistant" | null {
	for (let i = list.length - 1; i >= 0; i--) {
		const r = list[i]?.role;
		if (r === "user" || r === "assistant") return r;
	}
	return null;
}

/**
 * Marker on synthesized aborted placeholders so the metadata-source
 * search skips them. Exported so `buildAbortedAssistant` and
 * `findLatestRealAssistant` stay in sync. The literal is also
 * surfaced in the display layer (`isDanglingUser` in `message.tsx`),
 * which matches on the same string.
 */
const INTERRUPTED_MARKER = "[Interrupted by user]";

/**
 * Latest assistant message whose metadata (`api`/`provider`/`model`)
 * is safe to propagate onto a fresh synthesized placeholder. Skips
 * synthesized placeholders themselves — identified by the
 * `"aborted"` stopReason + `INTERRUPTED_MARKER` errorMessage pair —
 * so sequential dangling-user gaps don't compound (each placeholder
 * would otherwise inherit `model: "placeholder"` from the one
 * before it).
 *
 * Real user-aborted bubbles match the same predicate but their
 * metadata would propagate correctly anyway (same provider/model),
 * so skipping them is harmless. Documented as accepted widening in
 * docs/TODO.md.
 */
function findLatestRealAssistant(
	list: AgentMessage[],
): AssistantMessage | undefined {
	for (let i = list.length - 1; i >= 0; i--) {
		const m = list[i];
		if (m && m.role === "assistant" && !isSynthesizedAbort(m)) return m;
	}
	return undefined;
}

function isSynthesizedAbort(m: AssistantMessage): boolean {
	return m.stopReason === "aborted" && m.errorMessage === INTERRUPTED_MARKER;
}

function buildAbortedAssistant(
	prior: AssistantMessage | undefined,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		// Bland-default api/provider values used only when there's no
		// prior assistant message to inherit from (fresh session,
		// dangling user at index 0). Never sent to a provider — the
		// synthesized placeholder exists purely to satisfy the
		// alternation invariant pi-agent-core's `convertToLlm`
		// expects. Values match an existing shipped provider entry
		// (OpenRouter's `openai-completions` API) so pi-ai's model
		// registry round-trips cleanly if the placeholder ever
		// reaches a conversion path.
		api: prior?.api ?? ("openai-completions" as AssistantMessage["api"]),
		provider: prior?.provider ?? ("openrouter" as AssistantMessage["provider"]),
		model: prior?.model ?? "placeholder",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "aborted",
		errorMessage: INTERRUPTED_MARKER,
		timestamp: Date.now(),
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

export function listSessions(): SessionSummary[] {
	const db = getDb();
	const rows = db.select().from(sessions).orderBy(desc(sessions.id)).all();
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

/**
 * Short id for error/log messages. Uses the LAST 8 hex chars (random
 * tail of UUIDv7) — the first 8 are the ms-timestamp prefix and every
 * id written within the same minute shares it, making prefix-based
 * shortening useless for debugging.
 */
function shortId(id: string): string {
	return id.slice(-8);
}
