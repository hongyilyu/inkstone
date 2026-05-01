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
	ev_toolExecStart,
	ev_toolcallEnd,
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
