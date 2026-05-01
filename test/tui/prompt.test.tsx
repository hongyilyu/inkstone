/**
 * Prompt submission + slash dispatch.
 *
 * Verifies that typing into the textarea + pressing Enter:
 *   - calls the fake session's `actions.prompt` for plain prompts
 *   - dispatches `/clear` through the command registry (clearSession)
 *   - falls through to plain prompt on unknown slash
 *   - is gated off during streaming
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

describe("prompt submission", () => {
	test("plain text + Enter calls actions.prompt with the text", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("hello world");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		// `actions.prompt` is called inside `wrappedActions.prompt`
		// which awaits through a persistThen — give the microtask a tick.
		await Bun.sleep(20);

		expect(fake.calls.prompt).toEqual(["hello world"]);
	});

	test("/clear invokes clearSession", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Seed a turn so there's something to clear.
		await setup.mockInput.typeText("something");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("reply"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		await waitForFrame(setup, "reply");

		// Now type `/clear` and submit.
		await setup.mockInput.typeText("/clear");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		expect(fake.calls.clearSession).toBeGreaterThanOrEqual(1);
		// `/clear` text must NOT land as a plain prompt.
		expect(fake.calls.prompt).not.toContain("/clear");
	});

	test("unknown slash falls through as plain prompt", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Typing `/nope` triggers slash-mode and the dropdown filters to
		// zero matches (since no registered command is named `nope`).
		// When `filtered().length === 0` the dropdown's visibility is
		// false and its keyboard handler's Enter branch falls through
		// without preventDefault, so the textarea's Enter→submit fires.
		// We still need ESC here though, because while the dropdown is
		// open (slash mode, no whitespace) it catches arrow keys etc.
		// Submitting `/nope` directly after typing works because the
		// empty-match Enter is not consumed.
		await setup.mockInput.typeText("/nope");
		await setup.renderOnce();
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		expect(fake.calls.prompt).toEqual(["/nope"]);
	});

	test("submission gated off while streaming", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Turn 1
		await setup.mockInput.typeText("first");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		expect(fake.calls.prompt).toEqual(["first"]);

		// Stream starts — subsequent submits should be ignored until the turn ends.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("..."));
		await setup.renderOnce();

		await setup.mockInput.typeText("second");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		// `second` should NOT have been submitted.
		expect(fake.calls.prompt).toEqual(["first"]);

		// End the turn.
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
	});

	test("empty submit is a no-op", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		expect(fake.calls.prompt).toEqual([]);
	});

	test("/clear mid-stream invokes clearSession and wipes messages", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Seed a full turn so messages exist, then enter streaming
		// state for a second turn.
		await setup.mockInput.typeText("first");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("reply-1"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		await waitForFrame(setup, "reply-1");

		await setup.mockInput.typeText("second");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("reply-2"));
		await waitForFrame(setup, "reply-2");

		// Now /clear mid-stream. The wrapper awaits agentSession.
		// clearSession(); the fake resolves synchronously. Real Session
		// would `abort()` + `waitForIdle()` + `reset()`, but the TUI
		// wrapper's observable behavior is: clearSession called, store
		// messages wiped.
		await setup.mockInput.typeText("/clear");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(50);
		await setup.renderOnce();

		expect(fake.calls.clearSession).toBeGreaterThanOrEqual(1);
		// Messages gone from the store → frame no longer shows past text.
		const f = setup.captureCharFrame();
		expect(f).not.toContain("reply-1");
		expect(f).not.toContain("reply-2");
		expect(f).not.toContain("first");
		expect(f).not.toContain("second");
	});

	test("/clear wipes dynamic sidebar sections", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Seed a turn that upserts a sidebar section.
		await setup.mockInput.typeText("show notes");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit({
			type: "tool_execution_end",
			toolCallId: "sb1",
			toolName: "update_sidebar",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: {
					operation: "upsert",
					id: "notes",
					title: "Notes",
					content: "ephemeral content",
				},
			},
			isError: false,
		});
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "toolUse" })]));
		await waitForFrame(setup, "ephemeral content");

		// Submit /clear. wrappedActions.clearSession wipes
		// `store.sidebarSections` alongside messages + counters.
		await setup.mockInput.typeText("/clear");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(50);

		// The section should be gone from the frame.
		const start = Date.now();
		while (Date.now() - start < 1000) {
			await setup.renderOnce();
			if (!setup.captureCharFrame().includes("ephemeral content")) break;
			await Bun.sleep(30);
		}
		expect(setup.captureCharFrame()).not.toContain("ephemeral content");
	});
});
