/**
 * Streaming-flow tests.
 *
 * Verifies the end-to-end behavior of the event reducer:
 *   - multiple turns in sequence
 *   - tool-use + follow-up assistant message
 *   - agent-end pending-tool sweep when a turn is interrupted
 *   - interleaved thinking/text/tool parts
 *
 * Conversation.test.tsx covers single-turn rendering. This file focuses
 * on the *shape* of the reducer's mutations across a multi-event turn.
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

describe("streaming flow", () => {
	test("tool-use turn renders pre-tool text, tool line, and post-tool text", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await seedUserTurn(setup, "go");

		// First assistant boundary: pre-tool text + tool call.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Looking that up..."));
		fake.emit(ev_toolcallEnd("t1", "read", { path: "notes/x.md" }));
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		fake.emit(ev_toolExecStart("t1", "read", { path: "notes/x.md" }));
		fake.emit({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});

		// Second assistant boundary: post-tool summary.
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("Here's what I found."));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(
			ev_agentEnd([
				assistantMessage({ stopReason: "toolUse" }),
				assistantMessage({ stopReason: "stop" }),
			]),
		);

		const f = await waitForFrame(setup, "Here's what I found.");
		expect(f).toContain("Looking that up...");
		expect(f).toMatch(/⚙\s*read/);
	});

	test("agent_end mid-tool sweeps pending tool into error state", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await seedUserTurn(setup, "go");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_toolcallEnd("t2", "write", { path: "notes/x.md" }));
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		// NO `tool_execution_end` — simulates abort during tool run.
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "aborted" })]));

		// The pending tool should have been flipped to error and the
		// "Tool execution interrupted" message surfaced.
		await waitForFrame(setup, "Tool execution interrupted");
	});

	test("two sequential turns both render", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Turn 1
		await seedUserTurn(setup, "first");
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("first reply"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		await waitForFrame(setup, "first reply");

		// Turn 2
		await seedUserTurn(setup, "second");
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("second reply"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		const f = await waitForFrame(setup, "second reply");
		expect(f).toContain("first");
		expect(f).toContain("second");
	});

	test("duration footer appears after turn completes", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await seedUserTurn(setup, "hello");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("hi"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));

		// Before agent_end, no duration pip — `▣ Reader · <model>` only.
		await waitForFrame(setup, "hi");

		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		// After agent_end, a duration pip like `· 88ms` appears on the
		// footer line. Match: `▣ <agent> · <model> · <duration>`.
		const f = await waitForFrame(setup, /▣.*Reader.*·.*·\s*\d+/);
		expect(f).toMatch(/▣/);
	});

	test("effort stamp appears on turn-closing bubble when thinking level is non-off", async () => {
		// Seed the fake Session with a non-off thinking level. The
		// reducer snapshots store.thinkingLevel at the user-prompt
		// commit and applies it at agent_end — so we exercise the
		// whole path: seed → snapshot → agent_end stamp → render.
		const fake = makeFakeSession({ thinkingLevel: "high" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await seedUserTurn(setup, "hello");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("hi"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		// Footer shape: `▣ <agent> · <model> · <duration> · high`.
		// Anchor on `▣` so we don't pick up the prompt statusline's
		// own `· high` effort badge (which renders whenever
		// store.thinkingLevel is non-off).
		const f = await waitForFrame(setup, /▣[^▣\n]*·\s*high/);
		expect(f).toMatch(/▣[^▣\n]*Reader/);
	});

	test("effort stamp is absent when thinking level is off", async () => {
		// Default seeding is `thinkingLevel: "off"` — the stamp should
		// NOT render, matching today's non-reasoning default. Pins the
		// "deliberately don't persist off" contract.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await seedUserTurn(setup, "hello");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("hi"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		// Wait for the turn to close (duration pip on the footer).
		const f = await waitForFrame(setup, /▣[^▣\n]*Reader[^▣\n]*·[^▣\n]*·\s*\d+/);
		// No effort tier should appear on the assistant bubble's
		// footer line (anchored on `▣` to skip the prompt statusline).
		expect(f).not.toMatch(/▣[^▣\n]*·\s*(minimal|low|medium|high|xhigh|off)\b/);
	});

	test("mid-stream thinking-level switch doesn't relabel the effort stamp", async () => {
		// Pins the snapshot-at-turn-start invariant. If the reducer
		// were to read store.thinkingLevel at agent_end (rather than
		// the captured turnStartThinkingLevel), switching levels
		// mid-stream would relabel the historical bubble.
		//
		// Flow: seed the session with effort "high", submit a prompt
		// (the reducer snapshots "high" into turnStartThinkingLevel),
		// drive a mid-stream setThinkingLevel("low") directly on the
		// fake's Session handle — bypassing the TUI's wrappedActions
		// so the store doesn't also flip (the production wrapper would
		// propagate the new level into store.thinkingLevel, which is
		// exactly the store state we want to prove the reducer is NOT
		// reading). Then close the turn and check the stamp.
		const fake = makeFakeSession({ thinkingLevel: "high" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await seedUserTurn(setup, "hello");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("hi"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));

		// Mid-stream level switch on the session's internal state.
		// NOTE: we intentionally bypass the TUI `setThinkingLevel`
		// wrapper — that wrapper mutates `store.thinkingLevel` in
		// addition to delegating to the session, and a correct
		// reducer reads neither the post-switch store value nor the
		// session at agent_end time. Driving the session directly
		// exercises the "snapshot was captured at prompt time"
		// invariant cleanly.
		fake.getSession().actions.setThinkingLevel("low");

		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		// Bubble footer still says `· high` — the snapshot from the
		// user-prompt commit wins.
		const f = await waitForFrame(setup, /▣[^▣\n]*·\s*high/);
		expect(f).toMatch(/▣[^▣\n]*·\s*high/);
		// And the post-switch "low" value must NOT appear on the
		// bubble's footer line.
		expect(f).not.toMatch(/▣[^▣\n]*·\s*low\b/);
	});

	test("effort stamp survives multi-message tool-driven turn (last bubble only)", async () => {
		// Pins two related invariants on the agent_end stamp:
		//   1. The stamp lands on the turn-closing bubble only, not
		//      intermediate tool-call assistant messages.
		//   2. A multi-message turn still reads the snapshot captured
		//      at the single user-prompt commit (one snapshot per
		//      user turn, not per assistant message_end).
		const fake = makeFakeSession({ thinkingLevel: "medium" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await seedUserTurn(setup, "do work");

		// First assistant message — tool-call only, no text.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_toolcallEnd("tc1", "read", { path: "foo.md" }));
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		fake.emit(ev_toolExecStart("tc1", "read", { path: "foo.md" }));
		fake.emit({
			type: "tool_execution_end",
			toolCallId: "tc1",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});

		// Second assistant message — the turn-closing reply. This one
		// gets the duration + thinkingLevel stamp.
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("done"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		// The closing bubble carries `· medium`. The intermediate
		// tool-call bubble does NOT — the stamp is per-turn, not
		// per-message, and lands on `messages[length - 1]` in
		// agent_end. Anchor the match to the assistant footer glyph
		// `▣` so we don't collide with the prompt statusline's own
		// `· medium` badge (which appears whenever store.thinkingLevel
		// is non-off).
		const f = await waitForFrame(setup, /▣[^▣]*·\s*medium/);
		// Exactly one assistant-footer `▣ … · medium` line — anchoring
		// on `▣` skips the prompt statusline that also shows the
		// current effort.
		const matches = f.match(/▣[^▣\n]*·\s*medium/g) ?? [];
		expect(matches.length).toBe(1);
	});

	test("update_sidebar tool result creates a sidebar section", async () => {
		const fake = makeFakeSession();
		// Width 120 so sidebar renders (`showSidebar` is gated on
		// dimensions.width >= 100).
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		await seedUserTurn(setup, "show notes");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(
			ev_toolcallEnd("sb1", "update_sidebar", {
				operation: "upsert",
				id: "notes",
				title: "Notes",
				content: "first pass ideas",
			}),
		);
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		fake.emit(
			ev_toolExecStart("sb1", "update_sidebar", { operation: "upsert" }),
		);
		fake.emit({
			type: "tool_execution_end",
			toolCallId: "sb1",
			toolName: "update_sidebar",
			// The reducer reads `result.details` for `update_sidebar`'s
			// operation/id/title/content — mirror the tool's real shape.
			result: {
				content: [{ type: "text", text: "Sidebar section updated." }],
				details: {
					operation: "upsert",
					id: "notes",
					title: "Notes",
					content: "first pass ideas",
				},
			},
			isError: false,
		});
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "toolUse" })]));

		// The sidebar section "Notes" now renders on the right panel.
		const f = await waitForFrame(setup, "first pass ideas");
		expect(f).toContain("Notes");
		expect(f).toContain("first pass ideas");
	});

	test("update_sidebar delete op removes the section", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		await seedUserTurn(setup, "show then hide");

		// First turn: upsert a section via update_sidebar.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(
			ev_toolcallEnd("sb-up", "update_sidebar", {
				operation: "upsert",
				id: "notes",
				title: "Notes",
				content: "first pass ideas",
			}),
		);
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		fake.emit(
			ev_toolExecStart("sb-up", "update_sidebar", { operation: "upsert" }),
		);
		fake.emit({
			type: "tool_execution_end",
			toolCallId: "sb-up",
			toolName: "update_sidebar",
			result: {
				content: [{ type: "text", text: "Sidebar section updated." }],
				details: {
					operation: "upsert",
					id: "notes",
					title: "Notes",
					content: "first pass ideas",
				},
			},
			isError: false,
		});
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "toolUse" })]));

		await waitForFrame(setup, "first pass ideas");

		// Second turn: delete the section by id. The reducer path is a
		// distinct branch — `sections.filter((s) => s.id !== d.id)`.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(
			ev_toolcallEnd("sb-del", "update_sidebar", {
				operation: "delete",
				id: "notes",
			}),
		);
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		fake.emit(
			ev_toolExecStart("sb-del", "update_sidebar", { operation: "delete" }),
		);
		fake.emit({
			type: "tool_execution_end",
			toolCallId: "sb-del",
			toolName: "update_sidebar",
			result: {
				content: [{ type: "text", text: "Sidebar section removed." }],
				details: { operation: "delete", id: "notes" },
			},
			isError: false,
		});
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "toolUse" })]));

		// Give the reactive sidebar a chance to re-render, then assert
		// the section title + content are gone.
		const start = Date.now();
		while (Date.now() - start < 1500) {
			await setup.renderOnce();
			if (!setup.captureCharFrame().includes("first pass ideas")) break;
			await Bun.sleep(30);
		}
		const f2 = setup.captureCharFrame();
		expect(f2).not.toContain("first pass ideas");
		// The sidebar "Context" header is always shown; the section
		// title "Notes" should no longer be rendered as a section
		// header — but "Notes" is a common word, so we anchor on the
		// content string which is unique.
	});
});
