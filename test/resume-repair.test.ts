/**
 * Load-time repair for sessions killed mid-turn.
 *
 * The bug: a user hits Ctrl+C right after Enter, before pi-agent-core's
 * `message_end` for the assistant fires. On disk, `agent_messages` ends
 * with a lone `user` row — no closing assistant. Resuming and prompting
 * again would hand the provider `[..., user, user]`: Anthropic silently
 * merges into one turn, Bedrock 400s on `ValidationException`.
 *
 * The fix lives in `loadSession`: after reading `agent_messages`, if
 * the tail is `role: "user"`, append a synthetic aborted assistant so
 * the alternation invariant holds. Stored rows are untouched (pure
 * read-time repair).
 *
 * These tests seed the DB directly via the drizzle client to construct
 * the three shapes we care about: dangling tail, clean tail, dangling
 * tail with a prior assistant.
 */

import { describe, expect, test } from "bun:test";
import { getDb } from "@backend/persistence/db/client";
import {
	agentMessages,
	messages,
	sessions,
} from "@backend/persistence/db/schema";
import {
	createSession,
	loadSession,
} from "@backend/persistence/sessions";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import "./preload";

// ---------------------------------------------------------------------------
// Helpers. The drizzle test preload sets up isolated XDG dirs, so each
// `createSession` / `loadSession` call in this file lands in the fresh
// per-process SQLite DB.
// ---------------------------------------------------------------------------

function userMsg(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function assistantMsg(partial?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: partial?.content ? "" : "ok" }],
		api: "anthropic-messages",
		provider: "amazon-bedrock",
		model: "anthropic.claude-opus-4-7",
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...partial,
	};
}

/**
 * Seed a session row + a list of `agent_messages` rows. Skips the
 * `messages`/`parts` tables — `loadSession`'s repair is driven off
 * `agent_messages`, so the display side doesn't affect what we're
 * testing.
 */
function seedSession(rows: AgentMessage[]): string {
	const rec = createSession({ agent: "reader" });
	const db = getDb();
	for (let i = 0; i < rows.length; i++) {
		const m = rows[i];
		if (!m) continue;
		// A minimal "display header" for the user message so the loaded
		// `displayMessages` list isn't empty when downstream callers want
		// to render. Optional for this test file but cheap to add.
		if (m.role === "user" || m.role === "assistant") {
			db.insert(messages)
				.values({
					id: `${rec.id}-m${i}`,
					sessionId: rec.id,
					role: m.role,
					createdAt: Date.now(),
				})
				.run();
		}
		db.insert(agentMessages)
			.values({
				id: `${rec.id}-a${i}`,
				sessionId: rec.id,
				displayMessageId: null,
				data: m,
			})
			.run();
	}
	return rec.id;
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe("loadSession — tail repair", () => {
	test("dangling user tail → appends synthetic aborted assistant", () => {
		const sid = seedSession([userMsg(":q")]);
		const loaded = loadSession(sid);
		expect(loaded).not.toBeNull();
		const msgs = loaded!.agentMessages;
		expect(msgs.length).toBe(2);
		expect(msgs[0]?.role).toBe("user");
		const tail = msgs[1];
		expect(tail?.role).toBe("assistant");
		expect((tail as AssistantMessage).stopReason).toBe("aborted");
		expect((tail as AssistantMessage).errorMessage).toBe(
			"[Interrupted by user]",
		);
		// Placeholder content: one empty-text part. Non-empty text would
		// leak into the next turn's prompt.
		expect((tail as AssistantMessage).content).toEqual([
			{ type: "text", text: "" },
		]);
	});

	test("clean tail (user + assistant) → no synthetic appended", () => {
		const sid = seedSession([
			userMsg("hello"),
			assistantMsg(),
		]);
		const loaded = loadSession(sid);
		expect(loaded).not.toBeNull();
		const msgs = loaded!.agentMessages;
		expect(msgs.length).toBe(2);
		expect(msgs[1]?.role).toBe("assistant");
		expect((msgs[1] as AssistantMessage).stopReason).toBe("stop");
		expect((msgs[1] as AssistantMessage).errorMessage).toBeUndefined();
	});

	test(
		"dangling tail with prior assistant → placeholder inherits api/provider/model",
		() => {
			const sid = seedSession([
				userMsg("first"),
				assistantMsg({
					api: "openai-completions",
					provider: "openai",
					model: "gpt-5",
				}),
				userMsg("second (orphan)"),
			]);
			const loaded = loadSession(sid);
			expect(loaded).not.toBeNull();
			const msgs = loaded!.agentMessages;
			expect(msgs.length).toBe(4);
			const tail = msgs[3] as AssistantMessage;
			expect(tail.role).toBe("assistant");
			expect(tail.stopReason).toBe("aborted");
			expect(tail.api).toBe("openai-completions");
			expect(tail.provider).toBe("openai");
			expect(tail.model).toBe("gpt-5");
		},
	);

	test("empty session → no synthetic appended", () => {
		const sid = seedSession([]);
		const loaded = loadSession(sid);
		expect(loaded).not.toBeNull();
		expect(loaded!.agentMessages.length).toBe(0);
	});

	test(
		"dangling user on first turn (no prior assistant) → placeholder uses dummy metadata",
		() => {
			const sid = seedSession([userMsg(":q")]);
			const loaded = loadSession(sid);
			const tail = loaded!.agentMessages[1] as AssistantMessage;
			// Bland-default fallback values. Never sent to a provider —
			// they just satisfy the `AssistantMessage` type contract so
			// pi-agent-core can round-trip through `convertToLlm`.
			expect(tail.api).toBe("anthropic-messages");
			expect(tail.provider).toBe("amazon-bedrock");
			expect(tail.model).toBe("placeholder");
		},
	);

	test(
		"interior gap (user, user, assistant) → placeholder inserted between users",
		() => {
			// Real-world shape from the reproducer: the user Ctrl+C'd
			// after typing `:q`, resumed via Ctrl+N, then typed `test`.
			// On disk: user1, user2, assistant (the reply to the merged
			// pair). Without repair, the next prompt after resume would
			// hand Anthropic `[user1, user2, assistant, user3]` — still
			// valid at that point, BUT this test specifically guards the
			// case where the stored context is itself malformed and the
			// agent is about to continue from it.
			const sid = seedSession([
				userMsg(":q"),
				userMsg("test"),
				assistantMsg(),
			]);
			const loaded = loadSession(sid);
			const msgs = loaded!.agentMessages;
			expect(msgs.length).toBe(4);
			expect(msgs[0]?.role).toBe("user");
			expect(msgs[1]?.role).toBe("assistant");
			expect((msgs[1] as AssistantMessage).stopReason).toBe("aborted");
			expect((msgs[1] as AssistantMessage).errorMessage).toBe(
				"[Interrupted by user]",
			);
			expect(msgs[2]?.role).toBe("user");
			expect(msgs[3]?.role).toBe("assistant");
			expect((msgs[3] as AssistantMessage).stopReason).toBe("stop");
		},
	);

	test(
		"tool-result row between users → repair triggers on last user/assistant role",
		() => {
			// Regression guard for the C2 finding: if only the direct
			// neighbor is checked, a `toolResult` between two `user`s
			// masks the alternation gap and repair is skipped. Here we
			// seed `[user, toolResult, user]` and expect a synthesized
			// assistant between the two users — the repair pass must
			// look at the last *user|assistant* role, not the raw tail.
			const toolResult: AgentMessage = {
				role: "toolResult",
				toolCallId: "call-1",
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: Date.now(),
			};
			const sid = seedSession([
				userMsg("first"),
				toolResult,
				userMsg("second (orphan)"),
			]);
			const loaded = loadSession(sid);
			const msgs = loaded!.agentMessages;
			// user, toolResult, assistant (synthesized), user, assistant
			// (trailing synthesized for the second user's dangling tail).
			expect(msgs.length).toBe(5);
			expect(msgs[0]?.role).toBe("user");
			expect(msgs[1]?.role).toBe("toolResult");
			expect(msgs[2]?.role).toBe("assistant");
			expect((msgs[2] as AssistantMessage).stopReason).toBe("aborted");
			expect(msgs[3]?.role).toBe("user");
			expect(msgs[4]?.role).toBe("assistant");
			expect((msgs[4] as AssistantMessage).stopReason).toBe("aborted");
		},
	);

	test(
		"sequential dangling gaps → second placeholder doesn't inherit placeholder metadata",
		() => {
			// Without the `findLatestRealAssistant` skip, the second
			// synthesized placeholder would inherit `model: "placeholder"`
			// from the first. Guard: seed two `[user, user]` gaps with no
			// real assistant between them, confirm both synthesized
			// placeholders get the bland-default fallback — specifically,
			// the second one does NOT copy the first's placeholder model
			// back onto itself.
			const sid = seedSession([
				userMsg("first"),
				userMsg("second"),
				userMsg("third"),
			]);
			const loaded = loadSession(sid);
			const msgs = loaded!.agentMessages;
			// user, synthesized, user, synthesized, user, synthesized.
			expect(msgs.length).toBe(6);
			const placeholder1 = msgs[1] as AssistantMessage;
			const placeholder2 = msgs[3] as AssistantMessage;
			const placeholder3 = msgs[5] as AssistantMessage;
			expect(placeholder1.stopReason).toBe("aborted");
			expect(placeholder2.stopReason).toBe("aborted");
			expect(placeholder3.stopReason).toBe("aborted");
			// All three carry bland defaults because there's no REAL
			// assistant to source from. The skip prevents the second and
			// third from reading the first's "placeholder" string back.
			expect(placeholder1.model).toBe("placeholder");
			expect(placeholder2.model).toBe("placeholder");
			expect(placeholder3.model).toBe("placeholder");
		},
	);
});
