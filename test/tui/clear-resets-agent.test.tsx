/**
 * `/clear` ends an in-memory lifetime and starts a fresh one (ADR 0008).
 * A fresh lifetime is bound to the router by definition (ADR 0007 /
 * `resolveInitialAgentName`), so after `/clear` the bound agent must
 * read back as the router regardless of what the previous lifetime
 * held — same contract as launch.
 *
 * Without this contract a user who Tab-picked Reader, ran `/clear`,
 * and typed a freeform open-page message would silently bypass the
 * router (ADR 0007's "freeform open-page text classifies via the
 * router") and land on Reader instead.
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

describe("/clear returns to a fresh router-bound lifetime", () => {
	test("bound agent reads back as router after /clear from a non-router agent", async () => {
		const fake = makeFakeSession({ agentName: "reader" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		expect(setup.getAgent().store.currentAgent).toBe("reader");

		// Seed a turn so `/clear` exercises the realistic mid-session
		// shape (messages > 0 → backend `agent.abort()` + `waitForIdle`
		// path inside `clearSession`).
		await setup.mockInput.typeText("hi");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("reply"));
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		await waitForFrame(setup, "reply");

		await setup.mockInput.typeText("/clear");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(30);

		expect(setup.getAgent().store.currentAgent).toBe("router");
	});
});
