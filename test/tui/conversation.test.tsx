/**
 * Conversation rendering tests.
 *
 * Script a full turn via the fake session's `emit(AgentEvent)` so the
 * real reducer in `src/tui/context/agent.tsx` runs against synthetic
 * events. Assert that the rendered frame contains the expected prose.
 *
 * Markdown rendering is async (tree-sitter highlighting runs on a
 * worker), so assistant-body assertions go through `waitForFrame`
 * which polls renderOnce + captureCharFrame until the needle shows up
 * or the timeout fires.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	assistantMessage,
	ev_agentEnd,
	ev_agentStart,
	ev_messageEnd,
	ev_messageStart,
	ev_textDelta,
	ev_textStart,
	ev_thinkingDelta,
	ev_thinkingEnd,
	ev_thinkingStart,
	ev_toolcallEnd,
	ev_toolExecEnd,
	ev_toolExecStart,
	makeFakeSession,
} from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

async function seedUserTurn(setup_: NonNullable<typeof setup>, text: string) {
	await setup_.mockInput.typeText(text);
	setup_.mockInput.pressEnter();
	await setup_.renderOnce();
}

describe("conversation rendering", () => {
	test("user + assistant text round-trip", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await seedUserTurn(setup, "hello there");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Hi! "));
		fake.emit(ev_textDelta("How can I help?"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		const f = await waitForFrame(setup, "How can I help?");
		expect(f).toContain("hello there");
		expect(f).toContain("Hi!");
	});

	test("thinking block renders with Thinking: marker", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "q");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_thinkingStart());
		fake.emit(ev_thinkingDelta("let me consider"));
		fake.emit(ev_thinkingEnd("let me consider"));
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Answer"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		const f = await waitForFrame(setup, "Answer");
		expect(f).toContain("Thinking:");
		expect(f).toContain("let me consider");
	});

	test.each([
		["[REDACTED]"], // OpenRouter literal
		["Reasoning hidden by provider"], // pi-kiro slow-path marker (§26a)
	])("redacted thinking placeholder %p drops the part", async (placeholder) => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "q");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_thinkingStart());
		fake.emit(ev_thinkingDelta(placeholder));
		fake.emit(ev_thinkingEnd(placeholder));
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Direct answer"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		const f = await waitForFrame(setup, "Direct answer");
		expect(f).not.toContain(placeholder);
		expect(f).not.toContain("Thinking:");
	});

	test("tool call pending → completed", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "do something");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Working..."));
		fake.emit(ev_toolcallEnd("c1", "read", { path: "notes/foo.md" }));
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));

		// Pending state visible — tilde icon heading the tool line.
		await waitForFrame(setup, /~\s*read/);

		fake.emit(ev_toolExecStart("c1", "read", { path: "notes/foo.md" }));
		fake.emit(
			ev_toolExecEnd("c1", "read", {
				result: { content: [{ type: "text", text: "ok" }] },
			}),
		);
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "toolUse" })]));

		// `⚙` header glyph means the tool flipped to completed.
		await waitForFrame(setup, /⚙\s*read/);
	});

	test("pending → completed flip preserves sibling text parts", async () => {
		// Regression guard for the `<Index>` / `<Switch>` refactor in
		// `AssistantMessage`. This test asserts the *user-visible*
		// invariant that the fix aimed for — the streamed text is
		// continuously visible as a sibling tool part transitions
		// through pending → executing → completed without flicker.
		//
		// Honest limitation: the Solid reactivity harness renders
		// frames on demand via `renderOnce()`, so we can't directly
		// observe intermediate teardown-remount cycles. Both the
		// pre-fix `.map()` and the post-fix `<Index>` converge to
		// a final frame containing the full text — the pre-fix
		// version just does O(parts × tokens) more work and loses
		// markdown's incremental-parse state on every mutation. See
		// `docs/TODO.md` (this entry) for why this is specifically
		// a user-visible "flicker" regression rather than a dropped-
		// content regression. This test locks in the "no dropped
		// content across the tool transition" invariant as a floor;
		// a more aggressive mount-counter test would require
		// instrumenting `TextPart` via `mock.module`, which is
		// heavier than the risk warrants today.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "list files");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Scanning the vault for matches"));
		fake.emit(ev_toolcallEnd("s1", "read", { path: "notes/foo.md" }));
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));

		// Both the sibling text and the pending tool row visible.
		await waitForFrame(setup, "Scanning the vault for matches");
		await waitForFrame(setup, /~\s*read/);

		// Flip pending → completed. The text part must still be there.
		fake.emit(ev_toolExecStart("s1", "read", { path: "notes/foo.md" }));
		fake.emit(
			ev_toolExecEnd("s1", "read", {
				result: { content: [{ type: "text", text: "ok" }] },
			}),
		);
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "toolUse" })]));

		await waitForFrame(setup, /⚙\s*read/);
		expect(setup.captureCharFrame()).toContain(
			"Scanning the vault for matches",
		);
	});

	test("tool error surfaces the error line", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "go");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_toolcallEnd("c2", "read", { path: "missing" }));
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		fake.emit(ev_toolExecStart("c2", "read", { path: "missing" }));
		fake.emit(
			ev_toolExecEnd("c2", "read", {
				isError: true,
				result: {
					content: [{ type: "text", text: "File not found: missing" }],
				},
			}),
		);
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "toolUse" })]));

		await waitForFrame(setup, "File not found: missing");
	});

	test("assistant error panel renders when stopReason is error", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "bad");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(
			ev_messageEnd({
				stopReason: "error",
				errorMessage: "Provider returned 500",
			}),
		);
		fake.emit(
			ev_agentEnd([
				assistantMessage({
					stopReason: "error",
					errorMessage: "Provider returned 500",
				}),
			]),
		);

		await waitForFrame(setup, "Provider returned 500");
	});

	test("assistant aborted turn renders `· interrupted` footer, no error panel", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "go");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("partial reply"));
		// pi-agent-core forwards user abort through `message_end` with
		// `stopReason: "aborted"`. `errorMessage` happens to be populated
		// by pi-ai (usually the literal "[Interrupted by user]") — we
		// explicitly assert it does NOT appear in the frame, proving the
		// error-panel path is suppressed.
		fake.emit(
			ev_messageEnd({
				stopReason: "aborted",
				errorMessage: "[Interrupted by user]",
			}),
		);
		fake.emit(
			ev_agentEnd([
				assistantMessage({
					stopReason: "aborted",
					errorMessage: "[Interrupted by user]",
				}),
			]),
		);

		await waitForFrame(setup, "· interrupted");
		const frame = setup.captureCharFrame();
		// Error panel body text must not render — aborts don't produce
		// the scary red-bordered panel.
		expect(frame).not.toContain("[Interrupted by user]");
		// Footer shape: `▣ <agent> · <model> · interrupted`. Confirms the
		// suffix is part of the footer (not a stray string elsewhere) and
		// the glyph is present. Duration pip is explicitly absent —
		// aborted turns skip the `agent_end` duration stamp so a wall-
		// clock-until-abort value doesn't read like a completed-turn
		// duration next to `· interrupted`.
		expect(frame).toMatch(/▣ \S+ · \S+.* · interrupted/);
		expect(frame).not.toMatch(/· \d+(\.\d+)?\s*(ms|s) · interrupted/);
	});

	test("streaming interrupt hint appears during a turn and clears after", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "hi");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("..."));

		await waitForFrame(setup, "interrupt");

		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		// Wait for the hint to clear.
		const start = Date.now();
		while (Date.now() - start < 1000) {
			await setup.renderOnce();
			if (!setup.captureCharFrame().includes("interrupt")) break;
			await Bun.sleep(20);
		}
		expect(setup.captureCharFrame()).not.toContain("interrupt");
	});

	test("pre-stream actions.prompt rejection surfaces a synthetic error bubble", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Make the NEXT actions.prompt reject — simulates a pre-stream
		// failure like `getApiKey` rejection or a network error on the
		// very first request. pi-agent-core would normally wrap these in
		// a `stopReason === "error"` message_end, but the pre-stream
		// catch in `wrappedActions.prompt` (agent.tsx) handles the case
		// where nothing is emitted at all.
		fake.failNextPrompt(new Error("pre-stream boom"));

		await setup.mockInput.typeText("hello");
		setup.mockInput.pressEnter();

		// The reducer's catch block pushes a synthetic assistant bubble
		// with the error text. Also fires an "Agent error" toast.
		const f = await waitForFrame(setup, "pre-stream boom");
		expect(f).toContain("pre-stream boom");
	});

	test("user bubble with `@`-mention renders file chip (`[md]` + path)", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Type a plain text + `@`-mention to a seeded vault file.
		// preload.ts seeds bar.md and foo.md under 010 RAW/013 Articles.
		await setup.mockInput.typeText("look at ");
		await setup.mockInput.typeText("@");
		await waitForFrame(setup, "foo.md", { timeout: 3000 });
		// Select the top option — the insert writes `@<path> ` into the
		// buffer and attaches a virtual extmark covering the `@<path>` span.
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(50);

		// Submit.
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(50);

		// The user bubble renders `md` mime badge + the filename.
		// bar.md sorts first alphabetically, so it gets picked.
		const f = await waitForFrame(setup, "bar.md");
		// `md` chip appears on the bubble — MIME_BADGE maps "text/markdown" → "md".
		expect(f).toMatch(/\bmd\b/);
		// Filename present in the chip.
		expect(f).toContain("010 RAW/013 Articles/bar.md");
	});

	test("user bubble gets [Interrupted by user] when agent_end fires with empty assistant shell", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "hello");

		// Simulate the fast-model scenario: agent_start → message_start
		// (pushes empty assistant shell) → agent_end fires before any
		// text parts arrive. The reducer should stamp `interrupted` on
		// the user bubble.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		// No text deltas — the assistant shell stays empty.
		fake.emit(
			ev_agentEnd([
				assistantMessage({
					stopReason: "aborted",
					errorMessage: "[Interrupted by user]",
				}),
			]),
		);

		await waitForFrame(setup, "[Interrupted by user]");
		const frame = setup.captureCharFrame();
		expect(frame).toContain("[Interrupted by user]");
	});

	test("user bubble does NOT flash [Interrupted by user] during normal streaming", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "hello");

		// message_start pushes the empty assistant shell. Before any
		// text arrives, the user bubble must NOT show the marker —
		// the reducer hasn't stamped `interrupted` yet because
		// `agent_end` hasn't fired.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		await setup.renderOnce();
		await Bun.sleep(20);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("[Interrupted by user]");

		// Text arrives, turn completes normally.
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Hi there!"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		const f = await waitForFrame(setup, "Hi there!");
		expect(f).not.toContain("[Interrupted by user]");
	});

	test("sidebar Context block renders token count and cost after a turn with usage", async () => {
		const fake = makeFakeSession();
		// Width 120 so the sidebar renders (gated on `dimensions.width >= 100`).
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		await seedUserTurn(setup, "usage turn");

		// Close the turn with a non-zero usage payload. The reducer's
		// `message_end` branch increments `totalTokens` + `totalCost`
		// from the assistant message's `usage` field; the sidebar
		// `hasUsageData` memo flips truthy and the Context block
		// renders the tokens/cost lines.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("ok"));
		fake.emit(
			ev_messageEnd({
				stopReason: "stop",
				usage: {
					totalTokens: 1234,
					cost: { total: 0.05 },
				} as any, // deep-merge in assistantMessage() fills the rest
			}),
		);
		fake.emit(
			ev_agentEnd([
				assistantMessage({
					stopReason: "stop",
					usage: {
						totalTokens: 1234,
						cost: { total: 0.05 },
					} as any,
				}),
			]),
		);

		// "Context" header is always shown; token line + cost line
		// appear only when counters are non-zero.
		const f = await waitForFrame(setup, "1,234 tokens");
		expect(f).toContain("Context");
		expect(f).toContain("1,234 tokens");
		expect(f).toContain("$0.05");
	});
});
