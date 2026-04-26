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
	endedAt: integer("ended_at"),
	agent: text("agent").notNull(),
	activeArticle: text("active_article"),
	title: text("title"),
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
		error: text("error"),
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
		type: text("type", { enum: ["text", "thinking"] }).notNull(),
		text: text("text").notNull(),
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
