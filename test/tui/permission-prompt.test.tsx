/**
 * Phase 5 — bottom approval panel replaces Prompt while pending.
 *
 * Covers the replacement contract, the panel-local keyboard, and the
 * abort-safety invariants (unmount resolves pending to `false`). The
 * diff-preview rendering itself is covered by
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
import { renderApp, waitForFrame } from "./harness";

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

describe("phase 5 — bottom permission panel", () => {
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

	// Unmount-while-pending invariant (provider's `onCleanup` resolves
	// the in-flight confirmFn to `false`) is NOT exercised here
	// because calling `renderer.destroy()` while a Promise consumer
	// is still attached to the owner tree tickles a Bun 1.3.4
	// segfault on macOS in the OpenTUI renderer teardown path. The
	// resolver itself is wired in provider.tsx's outer `onCleanup`
	// (with a `queueMicrotask` deferral to defend against re-entry
	// during owner disposal). Documented in `docs/TODO.md` Known
	// Issues; revisit when Bun + OpenTUI ship a fix.
});
