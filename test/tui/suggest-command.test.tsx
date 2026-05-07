/**
 * Tests for the `suggest_command` tool + confirm panel + post-turn-end
 * replay wiring.
 *
 * Integration-level: push a user prompt to switch the layout to the
 * session view, then invoke the backend tool's TUI-injected resolver
 * to surface the suggestion panel, drive its outcomes, and assert the
 * replay path fires a `/article` that reaches `actions.prompt` (the
 * fake backend).
 */

import { describe, expect, test } from "bun:test";
import {
	getSuggestCommandFn,
	type SuggestCommandRequest,
} from "@backend/agent";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame, waitUntil } from "./harness";

async function seedUserMessage(
	setup: Awaited<ReturnType<typeof renderApp>>,
): Promise<void> {
	// Send a plain prompt so the layout leaves OpenPage and enters the
	// session view. The suggestion panel is only mounted inside the
	// session view (mirrors PermissionPrompt's scope — approvals and
	// suggestions never fire from OpenPage since both require an
	// in-flight LLM turn, which requires a prior user message).
	await setup.getAgent().actions.prompt("find me something to read");
}

describe("suggest_command", () => {
	test("confirm replays the slash as a fresh user turn", async () => {
		const fake = makeFakeSession();
		const setup = await renderApp({ session: fake.factory });
		await seedUserMessage(setup);

		const fn = getSuggestCommandFn();
		expect(fn).toBeFunction();
		const req: SuggestCommandRequest = {
			callId: "call-1",
			command: "article",
			args: "foo.md",
			rationale: "User wants to read foo.md.",
		};
		// Invoke the backend-side resolver directly — same call path the
		// suggest_command tool's execute() takes.
		if (!fn) throw new Error("suggest-command resolver not installed");
		const pending = fn(req);

		await waitForFrame(setup, "Suggested command");

		// Baseline: only the seed prompt has reached the fake so far.
		const seedPrompts = fake.calls.prompt.length;

		const agent = setup.getAgent();
		agent.respondSuggestion("confirmed");

		const decision = await pending;
		expect(decision).toBe("confirmed");

		// The replay effect fires when `store.isStreaming` is already
		// `false` (we never started streaming in this test), so the
		// replay queues on the next microtask after respondSuggestion.
		// Wait for the fake to receive the replayed prompt.
		await waitUntil(() => fake.calls.prompt.length > seedPrompts, {
			timeout: 2000,
			message: "prompt never called after confirm",
		});
		// Replay's payload is the full `/article` opening message
		// (workflow prelude + path + content), not a bare slash.
		// Pin both: the filename (cheap regression guard) AND a
		// workflow-prelude marker (so a regression routing the replay
		// to a non-article path would fail loudly).
		const replayPrompt = fake.calls.prompt[seedPrompts];
		expect(replayPrompt).toBeDefined();
		expect(replayPrompt!).toContain("foo.md");
		expect(replayPrompt!).toContain("Reading Workflow");
	});

	test("cancel resolves the tool without triggering replay", async () => {
		const fake = makeFakeSession();
		const setup = await renderApp({ session: fake.factory });
		await seedUserMessage(setup);
		const seedPrompts = fake.calls.prompt.length;

		const fn = getSuggestCommandFn();
		expect(fn).toBeFunction();
		if (!fn) throw new Error("suggest-command resolver not installed");
		const pending = fn({
			callId: "call-2",
			command: "article",
			args: "foo.md",
			rationale: "maybe",
		});

		await waitForFrame(setup, "Suggested command");

		const agent = setup.getAgent();
		agent.respondSuggestion("cancelled");

		const decision = await pending;
		expect(decision).toBe("cancelled");

		// Give the effect a chance to (wrongly) fire — streaming is
		// already false, so a queued replay would fire immediately.
		await Bun.sleep(100);
		expect(fake.calls.prompt.length).toBe(seedPrompts);
	});

	test("panel hides once the resolver settles", async () => {
		const fake = makeFakeSession();
		const setup = await renderApp({ session: fake.factory });
		await seedUserMessage(setup);

		const fn = getSuggestCommandFn();
		if (!fn) throw new Error("suggest-command resolver not installed");
		const pending = fn({
			callId: "call-3",
			command: "article",
			args: "foo.md",
			rationale: "for the test",
		});

		await waitForFrame(setup, "Suggested command");

		const agent = setup.getAgent();
		agent.respondSuggestion("cancelled");
		await pending;

		// After resolve, the panel unmounts and the Prompt cell should
		// reclaim the bottom.
		await waitUntil(
			() => {
				return !setup.captureCharFrame().includes("Suggested command");
			},
			{ timeout: 2000, message: "suggest panel never unmounted" },
		);
	});

	test("abort resolves an in-flight suggestion to cancelled", async () => {
		// Pins the BLOCKER that would otherwise deadlock the agent
		// loop: if `abort()` didn't resolve the pending suggestion
		// first, the tool's parked promise would never settle and
		// `waitForIdle()` downstream would hang. Same contract as
		// the approval path.
		const fake = makeFakeSession();
		const setup = await renderApp({ session: fake.factory });
		await seedUserMessage(setup);

		const fn = getSuggestCommandFn();
		if (!fn) throw new Error("suggest-command resolver not installed");
		const pending = fn({
			callId: "call-abort",
			command: "article",
			args: "foo.md",
			rationale: "should be cancelled by abort",
		});

		await waitForFrame(setup, "Suggested command");

		const agent = setup.getAgent();
		agent.actions.abort();
		// The resolver must settle without user intervention.
		const decision = await pending;
		expect(decision).toBe("cancelled");
	});

	test("clearSession resolves an in-flight suggestion to cancelled", async () => {
		// Parallel to abort: `/clear` also unwinds through
		// `agent.clearSession()` which calls `abort` + `waitForIdle`.
		// A pending suggestion must resolve so the clear completes.
		const fake = makeFakeSession();
		const setup = await renderApp({ session: fake.factory });
		await seedUserMessage(setup);

		const fn = getSuggestCommandFn();
		if (!fn) throw new Error("suggest-command resolver not installed");
		const pending = fn({
			callId: "call-clear",
			command: "article",
			args: "foo.md",
			rationale: "should be cancelled by clearSession",
		});

		await waitForFrame(setup, "Suggested command");

		const agent = setup.getAgent();
		// Fire-and-forget: clearSession awaits backend clear, but we
		// only care that the resolver settles first.
		void agent.actions.clearSession();
		const decision = await pending;
		expect(decision).toBe("cancelled");
	});
});
