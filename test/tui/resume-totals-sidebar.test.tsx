/**
 * Resume → totals → sidebar render, end-to-end.
 *
 * Existing coverage:
 *   - `resume-totals.test.ts` — `loadSession`'s rollup of per-turn
 *     `AssistantMessage.usage` into `loaded.totals.{tokens,cost}`.
 *   - `actions/resume.ts:74-75` — seeds `store.totalTokens` /
 *     `store.totalCost` from `loaded.totals`.
 *   - `sidebar.tsx:80-88` — renders both via `formatTokensFull` +
 *     `formatCost` when `hasUsageData` is true.
 *
 * Gap: nothing bridges the three. A regression in resume.ts (e.g. seeding
 * `totalTokens` from the wrong field) or sidebar.tsx (e.g. wiring up to
 * a different signal) would let `resume-totals.test.ts` stay green while
 * the user sees `0 tokens / $0.00 spent` after resume.
 *
 * Test seeds a session with one assistant `agent_message` carrying
 * `usage: { totalTokens: N, cost: { total: C } }`, opens the session
 * list panel, picks the row, and asserts the rendered sidebar.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	appendAgentMessage,
	appendDisplayMessage,
	createSession as createSessionRow,
	newId,
	runInTransaction,
	updateSessionTitle,
} from "@backend/persistence/sessions";
import type { DisplayMessage } from "@bridge/view-model";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

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

/**
 * Seed a session row with one user message + one assistant agent_message
 * carrying the supplied usage. Returns the new session id. Mirrors the
 * `seedSession` pattern from `session-list.test.tsx:42` — replicated
 * inline here because it's the second caller (per CLAUDE.md "factor out
 * on second consumer" wouldn't kick in until a third caller appears).
 */
function seedSessionWithUsage(
	preview: string,
	title: string,
	usage: Usage,
): string {
	const rec = createSessionRow({ agent: "reader" });
	const userMsg: DisplayMessage = {
		id: newId(),
		role: "user",
		parts: [{ type: "text", text: preview }],
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "openrouter",
		model: "anthropic/claude-opus-4.7",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
	runInTransaction((tx) => {
		appendDisplayMessage(tx, rec.id, userMsg);
		appendAgentMessage(tx, rec.id, {
			role: "user",
			content: preview,
			timestamp: Date.now(),
		});
		appendAgentMessage(tx, rec.id, assistant);
		updateSessionTitle(tx, rec.id, title);
	});
	return rec.id;
}

describe("resume → sidebar totals", () => {
	test("totals from agent_messages render on the sidebar after resume", async () => {
		// 1234 tokens → formatTokensFull → "1,234" (en-US locale).
		// $0.05 → formatCost → "$0.05".
		seedSessionWithUsage(
			"seed prompt",
			"Resumed Totals",
			makeUsage(1234, 0.05),
		);

		const fake = makeFakeSession();
		// Sidebar gates on `dimensions.width >= 100`. Width 120 matches
		// other sidebar-asserting tests in `streaming.test.tsx:308`.
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Open Ctrl+N session list panel and resume the seeded row.
		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, "Resumed Totals");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		// Wait for resume batch to settle. `restoreMessages` ran with
		// the seeded agent_messages; `setStore("totalTokens", ...)` ran
		// inside the same batch.
		const f = await waitForFrame(setup, "1,234 tokens");
		expect(f).toContain("1,234 tokens");
		// Cost line below the tokens line. `formatCost(0.05) === "$0.05"`.
		expect(f).toContain("$0.05 spent");
		// Sanity: resume actually fired. Without this, a regression
		// where the panel fails to dispatch but the sidebar happens to
		// render something else with "1,234" in it would silently pass.
		expect(fake.calls.restoreMessages.length).toBeGreaterThanOrEqual(1);
	});

	test("zero-totals session hides usage block (no '0 tokens' on sidebar)", async () => {
		// Pins `hasUsageData`: when both totals are 0, neither line
		// renders. Without this, a regression that always shows the
		// usage block would surface "0 tokens / $0.00 spent" on every
		// fresh session — visual noise.
		seedSessionWithUsage("zero-cost prompt", "Zero Totals", makeUsage(0, 0));

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, "Zero Totals");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		// Wait for the sidebar title to update — confirms resume landed.
		await waitForFrame(setup, "Zero Totals");
		// Give the resume batch a couple more ticks; `setStore` writes
		// land synchronously inside the batch but the next render cycle
		// is needed for the sidebar to re-evaluate.
		await Bun.sleep(50);
		await setup.renderOnce();

		const f = setup.captureCharFrame();
		expect(f).not.toContain(" tokens");
		expect(f).not.toContain(" spent");
		// Confirm the sidebar header itself is still present — without
		// this, a regression that just drops the whole sidebar would
		// pass the negative assertions above.
		expect(f).toContain("Context");
	});
});
