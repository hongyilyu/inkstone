/**
 * `forkSession()` persistence verb.
 *
 * Per ADR 0014, fork is the session primitive: it creates a child session
 * bound to a chosen target agent, with `parent_session_id` set on the
 * child, plus a forked-from marker (PR 1's `parts.type = "fork"`) and
 * any seed messages — all under one `withTransaction` per ADR 0012.
 *
 * Routing is one caller (PR 5); a future user-initiated fork is the
 * other. The primitive itself is uniform.
 */
import { describe, expect, test } from "bun:test";
import { getDb } from "@backend/persistence/db/client";
import {
	agentMessages,
	messages,
	parts,
	sessions,
} from "@backend/persistence/db/schema";
import {
	createSession,
	forkSession,
	loadSession,
} from "@backend/persistence/sessions";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { eq } from "drizzle-orm";
import "./preload";

function userAgentMsg(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

describe("forkSession", () => {
	test("creates child with parent FK, fork marker, and seeded messages", () => {
		const parent = createSession({ agent: "router" });
		const userText = "whats in foo";

		const child = forkSession({
			parentId: parent.id,
			parentAgent: "router",
			targetAgent: "reader",
			seedMessages: [
				{
					display: {
						// Caller's id is informational only — forkSession
						// re-allocates so the child session owns its rows.
						id: Bun.randomUUIDv7(),
						role: "user",
						parts: [{ type: "text", text: userText }],
					},
					agentMessage: userAgentMsg(userText),
				},
			],
		});

		// Child session row: bound to reader, parent FK set.
		expect(child.agent).toBe("reader");
		expect(child.parentSessionId).toBe(parent.id);

		const loaded = loadSession(child.id);
		expect(loaded).not.toBeNull();
		expect(loaded?.session.parentSessionId).toBe(parent.id);

		// Display rows: [userMsg, forkMarker]. User on top (parent
		// agent received it), divider below (announcing the routing
		// transition), child agent's reply will stream under the
		// divider when the seam fires.
		expect(loaded?.displayMessages.length).toBe(2);
		const userMsg = loaded?.displayMessages[0];
		expect(userMsg?.role).toBe("user");
		expect(userMsg?.parts[0]).toEqual({ type: "text", text: userText });
		// User message stamped with the parent agent's name — the
		// bubble footer reflects the originating agent (router) even
		// after the live agent has swapped to the child (reader).
		expect(userMsg?.agentName).toBe("router");
		const marker = loaded?.displayMessages[1];
		expect(marker?.role).toBe("assistant");
		expect(marker?.parts[0]).toEqual({
			type: "fork",
			parentSessionId: parent.id,
			targetAgent: "reader",
		});

		// agent_messages: turn 1 is the user message — the LLM-facing
		// stream is naive to the fork marker (per ADR 0015). loadSession
		// applies alternation repair (per ADR 0008) and synthesizes a
		// closing assistant message for the dangling-user tail (length
		// becomes 2: user + synthesized aborted assistant).
		expect(loaded?.agentMessages.length).toBe(2);
		expect(loaded?.agentMessages[0]?.role).toBe("user");
		expect(loaded?.agentMessages[1]?.role).toBe("assistant");
		expect(loaded?.agentMessages[0]?.content?.[0]).toEqual({
			type: "text",
			text: userText,
		});

		// agent_messages.display_message_id links the seeded user
		// agent_message to its display bubble (per docs/SQL.md). The
		// id MUST match userMsg.id, not seed.display.id — forkSession
		// re-allocates display ids inside the tx.
		const db = getDb();
		const agentMsgRows = db
			.select()
			.from(agentMessages)
			.where(eq(agentMessages.sessionId, child.id))
			.all();
		const userAgentRow = agentMsgRows.find((r) => r.data.role === "user");
		expect(userAgentRow?.displayMessageId).toBe(userMsg?.id ?? null);
	});

	test("seeds with no agentMessage when caller omits it (display-only seeding)", () => {
		const parent = createSession({ agent: "router" });
		const child = forkSession({
			parentId: parent.id,
			parentAgent: "router",
			targetAgent: "reader",
			seedMessages: [
				{
					display: {
						id: Bun.randomUUIDv7(),
						role: "user",
						parts: [{ type: "text", text: "hi" }],
					},
				},
			],
		});

		const loaded = loadSession(child.id);
		expect(loaded?.displayMessages.length).toBe(2);
		expect(loaded?.agentMessages.length).toBe(0);
	});

	test("atomicity: a mid-tx throw leaves no orphan rows on disk", () => {
		const parent = createSession({ agent: "router" });
		const db = getDb();
		const before = {
			sessions: db.select().from(sessions).all().length,
			messages: db.select().from(messages).all().length,
			parts: db.select().from(parts).all().length,
			agentMessages: db.select().from(agentMessages).all().length,
		};

		// Force a throw mid-tx via a circular reference on the
		// agentMessage — drizzle's `mode: "json"` column calls
		// `JSON.stringify` on the value at write time, which throws on
		// circular structures. The throw lands AFTER the child session
		// row + fork marker are already inserted, so the tx must roll
		// back to leave the DB unchanged.
		const circular: Record<string, unknown> = {
			role: "user",
			content: [{ type: "text", text: "boom" }],
			timestamp: Date.now(),
		};
		circular.self = circular;

		expect(() =>
			forkSession({
				parentId: parent.id,
				parentAgent: "router",
				targetAgent: "reader",
				seedMessages: [
					{
						display: {
							id: Bun.randomUUIDv7(),
							role: "user",
							parts: [{ type: "text", text: "boom" }],
						},
						// biome-ignore lint/suspicious/noExplicitAny: deliberately malformed for the rollback test
						agentMessage: circular as any,
					},
				],
			}),
		).toThrow();

		const after = {
			sessions: db.select().from(sessions).all().length,
			messages: db.select().from(messages).all().length,
			parts: db.select().from(parts).all().length,
			agentMessages: db.select().from(agentMessages).all().length,
		};
		// Counts unchanged — the tx rolled back fully.
		expect(after).toEqual(before);
	});
});
