/**
 * Bottom approval panel replaces Prompt while pending.
 *
 * Covers the replacement contract, the panel-local keyboard, and the
 * abort-safety invariants (abort / clearSession resolve pending to
 * `false`). The diff-preview rendering itself is covered by
 * `pending-approval-part.test.tsx`; we don't repeat those assertions.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	type ConfirmRequest,
	getConfirmFn,
} from "../../src/backend/agent/permissions";
import {
	assistantMessage,
	ev_agentStart,
	ev_messageStart,
	ev_toolcallEnd,
	makeFakeSession,
} from "./fake-session";
import { renderApp, waitForFrame, waitUntil } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

function simpleRequest(callId: string): ConfirmRequest {
	return {
		callId,
		title: "Write confirmation",
		message: "Allow write to /tmp/x.md?",
	};
}

/**
 * Push the assistant turn boundary that moves the layout out of
 * `OpenPage` and into the conversation branch. `confirmDirs` can only
 * fire mid-turn in the real flow, so the panel is only reachable once
 * the layout has swapped — the test has to mirror that.
 */
function primeConversation(fake: ReturnType<typeof makeFakeSession>) {
	fake.emit(ev_agentStart());
	fake.emit(ev_messageStart());
	fake.emit({
		type: "message_end",
		message: assistantMessage({ stopReason: "toolUse" }),
	});
}

describe("bottom permission panel", () => {
	test("panel replaces Prompt while an approval is pending", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });

		// Push a turn so the layout leaves OpenPage and renders the
		// conversation + Prompt cell (where the panel will swap in).
		primeConversation(fake);
		await waitForFrame(setup, "ctrl+p commands");

		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(simpleRequest("call-a"));
		fake.emit(ev_toolcallEnd("call-a", "write", { path: "/tmp/x.md" }));

		const frame = await waitForFrame(setup, "Permission required");
		expect(frame).toContain("Allow");
		expect(frame).toContain("Reject");
		expect(frame).toContain("enter confirm");
		expect(frame).not.toContain("ctrl+p commands");
		// Visual chrome parity with Prompt: the open `┃` bar + the
		// closing `╹` corner should both be present, matching
		// Prompt's three-piece layout but in warning color.
		expect(frame).toContain("┃");
		expect(frame).toContain("╹");

		setup.mockInput.pressEscape();
		await pending;
	});

	test("Enter on default selection approves (resolves true)", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		primeConversation(fake);
		await waitForFrame(setup, "ctrl+p commands");

		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(simpleRequest("call-b"));
		fake.emit(ev_toolcallEnd("call-b", "write", { path: "/tmp/x.md" }));

		await waitForFrame(setup, "Permission required");
		setup.mockInput.pressEnter();
		const result = await pending;
		expect(result).toBe(true);

		await waitForFrame(setup, "ctrl+p commands");
	});

	test("Right + Enter rejects (resolves false)", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		primeConversation(fake);
		await waitForFrame(setup, "ctrl+p commands");

		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(simpleRequest("call-c"));
		fake.emit(ev_toolcallEnd("call-c", "write", { path: "/tmp/x.md" }));

		await waitForFrame(setup, "Permission required");
		setup.mockInput.pressArrow("right");
		setup.mockInput.pressEnter();
		const result = await pending;
		expect(result).toBe(false);
	});

	test("Esc rejects (resolves false)", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		primeConversation(fake);
		await waitForFrame(setup, "ctrl+p commands");

		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(simpleRequest("call-d"));
		fake.emit(ev_toolcallEnd("call-d", "write", { path: "/tmp/x.md" }));

		await waitForFrame(setup, "Permission required");
		setup.mockInput.pressEscape();
		const result = await pending;
		expect(result).toBe(false);
	});

	test("actions.abort() while pending resolves to false and unmounts panel", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		primeConversation(fake);
		await waitForFrame(setup, "ctrl+p commands");

		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(simpleRequest("call-e"));
		fake.emit(ev_toolcallEnd("call-e", "write", { path: "/tmp/x.md" }));

		await waitForFrame(setup, "Permission required");
		expect(fake.calls.abort).toBe(0);

		// Call the wrapped abort action via the harness accessor.
		// Without the wrapper's respondApproval(false) call, this
		// await would hang — pi-agent-core's beforeToolCall holds the
		// Promise and the backend abort can't wake it.
		setup.getAgent().actions.abort();
		const result = await pending;
		expect(result).toBe(false);
		expect(fake.calls.abort).toBe(1);

		// Panel unmounted; Prompt restored.
		await waitForFrame(setup, "ctrl+p commands");
	});

	test("actions.clearSession() while pending resolves to false and unmounts panel", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		primeConversation(fake);
		await waitForFrame(setup, "ctrl+p commands");

		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(simpleRequest("call-f"));
		fake.emit(ev_toolcallEnd("call-f", "write", { path: "/tmp/x.md" }));

		await waitForFrame(setup, "Permission required");
		expect(fake.calls.clearSession).toBe(0);

		// clearSession is async; don't await it — the pending approval
		// must resolve synchronously (via the wrapper's pre-backend
		// respondApproval(false)) so the reducer can process
		// agent_end when the backend subsequently aborts and emits.
		void setup.getAgent().actions.clearSession();
		const result = await pending;
		expect(result).toBe(false);

		// Bounded wait: a regression where the wrapper fires
		// respondApproval but fails to propagate to the backend
		// would hang here indefinitely without a timeout.
		await waitUntil(() => fake.calls.clearSession === 1, {
			timeout: 2000,
			message: "clearSession never propagated to backend",
		});

		// Panel unmounted: clearSession empties messages, so the
		// layout swaps back to OpenPage. Verify via the logo text
		// that only OpenPage renders.
		await waitForFrame(setup, "inkstone");
	});

	// Unmount-while-pending invariant: provider's `onCleanup` must
	// resolve any in-flight `confirmFn` Promise to `false` so the
	// agent loop unwinds cleanly. The resolver lives in
	// `provider.tsx`'s outer `onCleanup` and uses `queueMicrotask` to
	// defer the resolve past owner disposal — without that deferral,
	// the Promise consumer waking inside `renderer.destroy()` tickles
	// a Bun 1.3.4 segfault on macOS (documented in `docs/TODO.md`
	// Known Issues).
	//
	// 2026-05-08 retry on Bun 1.3.4: skipping by default. Toggle the
	// `test.skip` to `test` locally to re-attempt; if green on a newer
	// Bun, ship un-skipped and remove the matching TODO entry.
	test.skip("renderer.destroy() while pending resolves the Promise to false", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		primeConversation(fake);
		await waitForFrame(setup, "ctrl+p commands");

		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(simpleRequest("call-unmount"));
		fake.emit(ev_toolcallEnd("call-unmount", "write", { path: "/tmp/x.md" }));
		await waitForFrame(setup, "Permission required");

		// Tear the renderer down with the Promise still pending.
		// `onCleanup` in provider.tsx's confirmFn install closes the
		// in-flight resolver via `queueMicrotask(() => resolver(false))`.
		setup.renderer.destroy();
		setup = undefined;

		// Promise should resolve to false within the microtask tick.
		const result = await pending;
		expect(result).toBe(false);
	});
});
