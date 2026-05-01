/**
 * ESC double-tap interrupt behavior.
 *
 * First ESC arms the interrupt: hint flips to "again to interrupt".
 * Second ESC within the 5s window calls `actions.abort`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	ev_agentStart,
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
});
