/**
 * Session-scope totals persistence across session restores.
 *
 * `loadSession` sums per-turn `AssistantMessage.usage` from every real
 * assistant row in `agent_messages` and returns it on the `totals`
 * field. The TUI seeds `store.totalTokens` / `store.totalCost` from this
 * on `resumeSession` so a reopened session doesn't display 0 usage
 * alongside N prior turns.
 *
 * Guarantees under test:
 *   1. Real assistant turns contribute to the rollup.
 *   2. Synthesized alternation-repair placeholders (they have no
 *      `usage`) contribute 0.
 *   3. Empty sessions return 0/0 (no NaN).
 *   4. Assistant rows missing `usage` (older data, aborted-no-usage)
 *      contribute 0 without poisoning the sum.
 *   5. Assistant rows with `usage` but missing `cost.total` (defensive
 *      guard against a provider-typed-but-omitted field) contribute
 *      their tokens but 0 cost.
 */

import { describe, expect, test } from "bun:test";
import { getDb } from "@backend/persistence/db/client";
import { agentMessages, messages } from "@backend/persistence/db/schema";
import {
	createSession,
	loadSession,
	newId,
} from "@backend/persistence/sessions";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
import "./preload";

function userMsg(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function makeUsage(tokens: number, cost: number): Usage {
	return {
		input: Math.floor(tokens / 2),
		output: Math.ceil(tokens / 2),
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
	};
}

function assistantMsg(partial?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "openrouter",
		model: "anthropic/claude-opus-4.7",
		usage: makeUsage(30, 0.001),
		stopReason: "stop",
		timestamp: Date.now(),
		...partial,
	};
}

function seedSession(rows: AgentMessage[]): string {
	const rec = createSession({ agent: "reader" });
	const db = getDb();
	// Use UUIDv7 ids (same as production) so `loadSession`'s
	// `ORDER BY asc(id)` yields insertion order regardless of list
	// length. A naive `${rec.id}-a${i}` scheme would sort `a10` before
	// `a2` once a test grew past 10 rows — `newId()` dodges the footgun.
	for (const m of rows) {
		if (m.role === "user" || m.role === "assistant") {
			db.insert(messages)
				.values({
					id: newId(),
					sessionId: rec.id,
					role: m.role,
					createdAt: Date.now(),
				})
				.run();
		}
		db.insert(agentMessages)
			.values({
				id: newId(),
				sessionId: rec.id,
				displayMessageId: null,
				data: m,
			})
			.run();
	}
	return rec.id;
}

describe("loadSession — totals rollup", () => {
	test("sums usage across multiple assistant turns", () => {
		const sid = seedSession([
			userMsg("q1"),
			assistantMsg({ usage: makeUsage(100, 0.01) }),
			userMsg("q2"),
			assistantMsg({ usage: makeUsage(250, 0.03) }),
		]);
		const loaded = loadSession(sid);
		expect(loaded).not.toBeNull();
		expect(loaded!.totals.tokens).toBe(350);
		expect(loaded!.totals.cost).toBeCloseTo(0.04, 6);
	});

	test("empty session → zero totals", () => {
		const sid = seedSession([]);
		const loaded = loadSession(sid);
		expect(loaded!.totals.tokens).toBe(0);
		expect(loaded!.totals.cost).toBe(0);
	});

	test("synthesized alternation-repair placeholders contribute 0", () => {
		// Dangling user tail → repair appends a synthetic assistant
		// with no `usage` field. The rollup must NOT include it.
		const sid = seedSession([
			userMsg("q1"),
			assistantMsg({ usage: makeUsage(100, 0.01) }),
			userMsg("q2-orphan"),
		]);
		const loaded = loadSession(sid);
		// Repair appended one placeholder → 4 agentMessages.
		expect(loaded!.agentMessages.length).toBe(4);
		expect(loaded!.totals.tokens).toBe(100);
		expect(loaded!.totals.cost).toBeCloseTo(0.01, 6);
	});

	test("assistant row missing usage contributes 0 without NaN", () => {
		// Older assistant rows (pre-usage-capture) or genuinely
		// usage-less aborts shouldn't poison the sum.
		const sid = seedSession([
			userMsg("q1"),
			assistantMsg({ usage: undefined }),
			userMsg("q2"),
			assistantMsg({ usage: makeUsage(42, 0.005) }),
		]);
		const loaded = loadSession(sid);
		expect(loaded!.totals.tokens).toBe(42);
		expect(loaded!.totals.cost).toBeCloseTo(0.005, 6);
		expect(Number.isNaN(loaded!.totals.tokens)).toBe(false);
		expect(Number.isNaN(loaded!.totals.cost)).toBe(false);
	});

	test("usage present but cost.total missing → tokens counted, cost 0", () => {
		// Defensive guard: pi-ai types `cost.total` as non-optional,
		// but a provider could write `usage` without a cost breakdown.
		// `+ undefined` would NaN-poison the sum without the `?? 0`.
		const brokenUsage = {
			input: 5,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: undefined as unknown as Usage["cost"],
		} satisfies Usage;
		const sid = seedSession([
			userMsg("q1"),
			assistantMsg({ usage: brokenUsage }),
		]);
		const loaded = loadSession(sid);
		expect(loaded!.totals.tokens).toBe(10);
		expect(loaded!.totals.cost).toBe(0);
		expect(Number.isNaN(loaded!.totals.cost)).toBe(false);
	});
});
