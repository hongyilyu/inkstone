/**
 * Assistant-footer placement regression test.
 *
 * Tool-driven turns emit multiple assistant `message_end` events: the
 * pre-tool "I'm going to call X" bubble, any mid-turn "now I'm
 * thinking about the result" bubble, and the final "here's what I
 * found" bubble. Only the turn-closing bubble (`stopReason !== "toolUse"`)
 * should carry the `▣ Reader · claude-opus-4-7` footer — intermediate
 * bubbles must not. Mirrors OpenCode's `MessageFooter` placement.
 *
 * Before the fix: `stampAssistantBubbleMeta` ran on every
 * `message_end` and stamped `agentName` + `modelName` on every
 * assistant bubble, so `AssistantFooter` rendered its `▣ …` line
 * between the intermediate stop and the tool-call display, then
 * again at the end of the turn. Two footers per turn was visually
 * noisy and wrong.
 *
 * After the fix: `agentName` + `modelName` are stamped at `agent_end`
 * in `stampTurnClosingBubble` against the turn-closing bubble only.
 * Intermediate bubbles are left without these fields, so
 * `AssistantFooter`'s gate (`modelName || interrupted`) keeps them
 * footer-less.
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
	ev_toolcallEnd,
	ev_toolExecEnd,
	ev_toolExecStart,
	FAKE_MODEL,
	makeFakeSession,
} from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

describe("assistant footer placement", () => {
	test("only one `▣` footer appears after a tool-driven turn", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });

		// Script a full turn: user prompt is sent via the wrapped
		// action so a user bubble exists (required for any assistant
		// message_end to land on the right place in the messages
		// array). The reducer pushes a user message to the store
		// before agent events fire.
		void setup.getAgent().actions.prompt("hello");
		await waitForFrame(setup, "hello");

		// Intermediate assistant bubble: text + tool call, then
		// message_end with stopReason: "toolUse".
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("About to call write..."));
		fake.emit(ev_toolcallEnd("call-1", "write", { path: "/tmp/x.md" }));
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));

		// Tool executes.
		fake.emit(ev_toolExecStart("call-1", "write", { path: "/tmp/x.md" }));
		fake.emit(ev_toolExecEnd("call-1", "write"));

		// Turn-closing assistant bubble: text only, message_end with
		// stopReason: "stop".
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Done."));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));

		// `agent_end` with `messages` carrying the final assistant
		// message — reducer reads it for the provider/model that
		// produced the closing reply.
		fake.emit(
			ev_agentEnd([
				assistantMessage({ stopReason: "stop", model: FAKE_MODEL.id }),
			]),
		);

		await waitForFrame(setup, "Done.");

		// The final frame contains the closing bubble's footer (one
		// `▣` glyph). If `stampAssistantBubbleMeta` had stamped on
		// the intermediate bubble too, we'd see two `▣` glyphs.
		const frame = setup.captureCharFrame();
		const footerGlyphCount = (frame.match(/▣/g) ?? []).length;
		expect(footerGlyphCount).toBe(1);
		// And the footer is on the CLOSING bubble — assert the
		// `agentName · modelName` segment lands, not just a bare
		// `▣ Reader`. A regression that moved the stamp to the
		// intermediate bubble would also pass the count assertion
		// above; this tightens the check.
		expect(frame).toMatch(/▣ Reader · Anthropic: Claude Opus 4\.7/);
	});
});
