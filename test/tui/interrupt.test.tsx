/**
 * ESC double-tap interrupt behavior.
 *
 * First ESC arms the interrupt: hint flips to "again to interrupt".
 * Second ESC within the 5s window calls `actions.abort`.
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

describe("interrupt", () => {
	test("single ESC flips the hint; second ESC aborts", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Submit a prompt, then drive the fake into streaming state.
		await setup.mockInput.typeText("hi");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("thinking..."));
		// Wait until the interrupt hint shows — confirms the registry
		// has re-derived with `isStreaming === true` and `session_interrupt`
		// is globally dispatchable.
		await waitForFrame(setup, "esc interrupt");

		// First ESC: arms interrupt, hint flips.
		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(20);
		await setup.renderOnce();
		const armed = setup.captureCharFrame();
		expect(armed).toContain("again to interrupt");
		expect(fake.calls.abort).toBe(0);

		// Second ESC within the window: abort.
		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(20);

		expect(fake.calls.abort).toBe(1);
	});

	test("ESC does nothing when no turn is in flight", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(20);

		// Not streaming; abort should not fire.
		expect(fake.calls.abort).toBe(0);
	});

	test("interrupt arm resets when turn ends before the second ESC", async () => {
		// Intentional divergence from OpenCode documented in the TODO:
		// a single ESC late in a turn must NOT carry over to the next
		// turn. The `createEffect(() => { if (!store.isStreaming)
		// setInterrupt(0) })` in prompt.tsx clears the counter on turn
		// end; this test pins that behavior.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Turn 1: stream, arm interrupt (single ESC), end the turn
		// cleanly, verify abort was NOT called.
		await setup.mockInput.typeText("first");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("t1 body"));
		await waitForFrame(setup, "esc interrupt");

		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(20);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).toContain("again to interrupt");
		expect(fake.calls.abort).toBe(0);

		// Close the turn. The `isStreaming → false` transition fires
		// the reset effect; the counter goes back to 0.
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		await Bun.sleep(20);
		await setup.renderOnce();

		// Turn 2: stream again. First ESC should arm (not abort).
		await setup.mockInput.typeText("second");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("t2 body"));
		await waitForFrame(setup, "esc interrupt");

		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		// Still zero aborts — the counter reset between turns, so one
		// ESC in turn 2 arms without firing.
		expect(fake.calls.abort).toBe(0);
		expect(setup.captureCharFrame()).toContain("again to interrupt");
	});
});
