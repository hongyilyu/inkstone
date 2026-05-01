/**
 * Agent cycle keybind.
 *
 * Tab / Shift+Tab on the open page switches `store.currentAgent`. Once
 * any message lands, the agent is locked (D13 in AGENT-DESIGN.md) and
 * the keybind registration short-circuits.
 *
 * We verify the switch via the prompt-bar status line — it renders
 * `agentInfo().displayName` next to the model/provider, so when the
 * active agent changes from `reader` (displayName "Reader") to
 * `example` (displayName "Example"), the frame updates accordingly.
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

describe("agent cycle", () => {
	test("Tab on open page cycles to the next agent", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Starts on Reader (default agent, index 0).
		await waitForFrame(setup, "Reader");

		setup.mockInput.pressTab();
		await waitForFrame(setup, "Example");
	});

	test("Shift+Tab cycles in reverse", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await waitForFrame(setup, "Reader");

		setup.mockInput.pressTab({ shift: true });
		// Two-agent registry → Shift+Tab from Reader also lands on Example.
		await waitForFrame(setup, "Example");
	});

	test("agent cycle is disabled once the session has messages", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Seed a full turn so `store.messages.length > 0`.
		await setup.mockInput.typeText("hi");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("ok"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		await waitForFrame(setup, "ok");

		// Now Tab should be a no-op — the registration returns [] when
		// `store.messages.length > 0`. The prompt bar still shows
		// "Reader" (the agent stamp on the prompt bar is hidden once
		// messages exist — the bar shows agent · model · provider).
		// We assert by checking the agent hasn't flipped to Example.
		setup.mockInput.pressTab();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		const f = setup.captureCharFrame();
		expect(f).not.toContain("Example ");
	});

	test("/article falls through as plain prompt on a non-reader agent", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Cycle to Example.
		setup.mockInput.pressTab();
		await waitForFrame(setup, "Example");

		// Type `/article foo.md` and submit. Example doesn't declare
		// `/article`, so `triggerSlash` returns false and the text
		// falls through to the plain-prompt path. The fake records
		// `actions.prompt` with the literal `/article foo.md`.
		await setup.mockInput.typeText("/article foo.md");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(30);

		expect(fake.calls.prompt.length).toBe(1);
		expect(fake.calls.prompt[0]).toBe("/article foo.md");
	});
});
