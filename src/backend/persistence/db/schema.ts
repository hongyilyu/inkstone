/**
 * Drizzle schema for Inkstone's SQLite persistence layer.
 *
 * See docs/SQL.md for the authoritative design doc. This file is the
 * source of truth for column types and indexes; the doc is the source
 * of truth for why columns exist and how they're used.
 *
 * Identity: UUIDv7 on `sessions`, `messages`, `agent_messages`.
 * `parts` uses composite `(message_id, seq)` — no cross-session identity.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	startedAt: integer("started_at").notNull(),
	agent: text("agent").notNull(),
	title: text("title").notNull(),
});

export const messages = sqliteTable(
	"messages",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		role: text("role", { enum: ["user", "assistant"] }).notNull(),
		agentName: text("agent_name"),
		modelName: text("model_name"),
		durationMs: integer("duration_ms"),
		// Per-turn reasoning effort stamp. Stored as opaque TEXT (same
		// posture as `agentName`/`modelName`) — the pi-agent-core
		// `ThinkingLevel` enum is validated at the config write boundary,
		// not here. NULL when the turn produced no effort (non-reasoning
		// model or effort `"off"`); the renderer treats NULL and `"off"`
		// identically.
		thinkingLevel: text("thinking_level"),
		error: text("error"),
		// Mirrors `DisplayMessage.interrupted`. Split from `error` so
		// resumed sessions can re-render the `· interrupted` footer
		// suffix on aborted turns (stopReason "aborted") instead of
		// painting a red error panel. `0 | 1` via SQLite integer.
		interrupted: integer("interrupted", { mode: "boolean" }),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [index("messages_session_id_idx").on(t.sessionId, t.id)],
);

export const parts = sqliteTable(
	"parts",
	{
		messageId: text("message_id")
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		seq: integer("seq").notNull(),
		type: text("type", {
			enum: ["text", "thinking", "file", "tool"],
		}).notNull(),
		// `text` is the body of text/thinking parts AND is unused for
		// `file` / `tool` parts — kept NOT NULL with an empty string on
		// those rows rather than widening to nullable, because the
		// invariant "text parts have a body" is easier to read as a
		// NOT NULL column than as a per-type check. File parts carry
		// their display metadata in `mime` + `filename`; tool parts
		// carry theirs in `call_id` + `tool_data`.
		text: text("text").notNull(),
		// File-part display metadata. NULL for text/thinking/tool rows.
		// Two flat columns (not JSON) so the `listSessions` preview
		// fallback can read `filename` in SQL without JSON extraction.
		mime: text("mime"),
		filename: text("filename"),
		// Tool-part metadata. NULL for text/thinking/file rows.
		// `call_id` is pi-ai's `ToolCall.id` — the join key between the
		// `toolcall_end` stream event and the later `tool_execution_end`
		// event that flips the part from pending → completed/error.
		// `tool_data` holds `{ name, args, state, error? }` as JSON — no
		// SQL reader needs the inner fields.
		callId: text("call_id"),
		toolData: text("tool_data", { mode: "json" }).$type<{
			name: string;
			args: unknown;
			state: "pending" | "completed" | "error";
			error?: string;
		}>(),
	},
	(t) => [primaryKey({ columns: [t.messageId, t.seq] })],
);

/**
 * Raw pi-agent-core `AgentMessage` as JSON. `data` is typed at the TS
 * layer via `$type<AgentMessage>()` but stored as TEXT — Drizzle does
 * no runtime validation. Trust only pinned pi-agent-core versions.
 *
 * `display_message_id` is a nullable back-reference to the
 * `DisplayMessage` this agent message produced. Populated when the
 * mapping is obvious (assistant message → its bubble). NULL for
 * tool-result, user, and custom messages that don't render as bubbles.
 */
export const agentMessages = sqliteTable(
	"agent_messages",
	{
		id: text("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		displayMessageId: text("display_message_id").references(() => messages.id, {
			onDelete: "set null",
		}),
		data: text("data", { mode: "json" }).$type<AgentMessage>().notNull(),
	},
	(t) => [
		index("agent_messages_session_id_idx").on(t.sessionId, t.id),
		index("agent_messages_display_idx").on(t.displayMessageId),
	],
);
