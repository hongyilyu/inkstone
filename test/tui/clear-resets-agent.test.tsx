/**
 * `/clear` rebinds the live Session back to the default (router) agent.
 *
 * Per ADR 0007, freeform open-page text classifies through the router.
 * Without this rebind a user who Tab-picked Reader, ran `/clear`, and
 * typed a freeform message would still hit Reader because `/clear`
 * wipes messages but leaves the bound agent untouched.
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

async function seedTurn(
	s: NonNullable<typeof setup>,
	fake: ReturnType<typeof makeFakeSession>,
	reply: string,
) {
	await s.mockInput.typeText("hi");
	s.mockInput.pressEnter();
	await s.renderOnce();
	fake.emit(ev_agentStart());
	fake.emit(ev_messageStart());
	fake.emit(ev_textStart());
	fake.emit(ev_textDelta(reply));
	fake.emit(ev_messageEnd({ stopReason: "stop" }));
	fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
	await waitForFrame(s, reply);
}

describe("/clear resets bound agent to router", () => {
	test("rebinds to router when previous agent is non-router", async () => {
		// Reader is non-router; the fake default would also work but
		// being explicit pins the precondition.
		const fake = makeFakeSession({ agentName: "reader" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		expect(setup.getAgent().store.currentAgent).toBe("reader");

		// Seed a turn so `/clear` exercises the realistic mid-session
		// shape (messages > 0 → backend `agent.abort()` + `waitForIdle`
		// path inside `clearSession`).
		await seedTurn(setup, fake, "reply");

		await setup.mockInput.typeText("/clear");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(30);

		expect(fake.calls.clearSession).toBeGreaterThanOrEqual(1);
		expect(fake.calls.selectAgent[fake.calls.selectAgent.length - 1]).toBe(
			"router",
		);
		expect(setup.getAgent().store.currentAgent).toBe("router");
	});

	test("no redundant selectAgent when already on router", async () => {
		const fake = makeFakeSession({ agentName: "router" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		expect(setup.getAgent().store.currentAgent).toBe("router");

		await seedTurn(setup, fake, "ok");

		await setup.mockInput.typeText("/clear");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(30);

		expect(fake.calls.clearSession).toBeGreaterThanOrEqual(1);
		// Already on router → no rebind needed; calling `selectAgent`
		// would be a wasted notify() round-trip through the snapshot
		// subscription.
		expect(fake.calls.selectAgent).toEqual([]);
		expect(setup.getAgent().store.currentAgent).toBe("router");
	});
});
