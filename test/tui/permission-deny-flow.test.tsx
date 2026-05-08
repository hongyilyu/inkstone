/**
 * Permission deny → tool-error → next-turn-unblocked, end-to-end.
 *
 * `permission-prompt.test.tsx` covers the panel mechanics in isolation
 * (Enter approves, Esc/Right rejects, abort/clearSession resolve to
 * false). What it doesn't pin: the *propagation* chain when a user
 * rejects.
 *
 * Real flow: `toolcall_end` pushes a `pending` tool part → backend
 * `confirmDirs` rule awaits `confirmFn` → user rejects → `confirmFn`
 * resolves `false` → `evaluateRule` returns `{ block: true, reason:
 * "User declined." }` → pi-agent-core skips `tool_execution_start` and
 * emits `tool_execution_end` with `isError: true` → reducer flips the
 * tool part to `error` state → next user prompt starts a fresh turn.
 *
 * Tests in this file simulate the synthetic events pi-agent-core would
 * emit on a denied call (the `confirmFn` itself is exercised by
 * `permission-prompt.test.tsx`; this file picks up after the rejection
 * and verifies the rest of the chain).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	type ConfirmRequest,
	getConfirmFn,
} from "../../src/backend/agent/permissions";
import {
	assistantMessage,
	ev_agentEnd,
	ev_agentStart,
	ev_messageStart,
	ev_toolcallEnd,
	ev_toolExecEnd,
	makeFakeSession,
} from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

function denyRequest(callId: string): ConfirmRequest {
	return {
		callId,
		title: "Write confirmation",
		message: "Allow write to /tmp/deny-target.md?",
	};
}

/**
 * Drive a real user-prompt submission so `ensureSession()` creates a
 * sessionId, then emit the assistant turn boundary so the layout
 * swaps out of OpenPage into the conversation branch.
 *
 * Distinct from `permission-prompt.test.tsx`'s same-named helper —
 * THAT one skips the real prompt because its tests only assert on the
 * `confirmFn` Promise (no tool-state mutations, no `persistThen` gate
 * to satisfy). This file's tests assert on tool-part state flips,
 * which require a non-null sessionId via `ensureSession()`. Renamed
 * locally to keep the two helpers' contracts unambiguous to a
 * maintainer copy-pasting between files.
 */
async function seedSessionForToolStateMutation(
	s: NonNullable<typeof setup>,
	fake: ReturnType<typeof makeFakeSession>,
) {
	await s.mockInput.typeText("seed");
	s.mockInput.pressEnter();
	await s.renderOnce();
	await Bun.sleep(20);
	fake.emit(ev_agentStart());
	fake.emit(ev_messageStart());
	fake.emit({
		type: "message_end",
		message: assistantMessage({ stopReason: "toolUse" }),
	});
}

describe("permission deny propagation", () => {
	test("rejecting an approval flips the tool part to error state", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await seedSessionForToolStateMutation(setup, fake);
		await waitForFrame(setup, "ctrl+p commands");

		// Install a pending approval and emit the matching toolcall_end
		// so the reducer pushes a `pending` tool part keyed on the same
		// callId. (Order is intentionally `confirm()` first, then
		// `toolcall_end`, matching the real ordering: pi-agent-core
		// awaits `beforeToolCall` — which calls confirmFn — *before*
		// emitting the toolcall_end event the reducer sees.)
		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(denyRequest("call-deny-1"));
		fake.emit(
			ev_toolcallEnd("call-deny-1", "write", { path: "/tmp/deny-target.md" }),
		);

		await waitForFrame(setup, "Permission required");

		// Reject (Right toggles to "Reject", Enter commits — same path
		// permission-prompt.test.tsx pins).
		setup.mockInput.pressArrow("right");
		setup.mockInput.pressEnter();
		const result = await pending;
		expect(result).toBe(false);

		// The bottom panel unmounted; layout returned to Prompt.
		await waitForFrame(setup, "ctrl+p commands");

		// pi-agent-core's `block: true` short-circuits `tool_execution_start`
		// and synthesizes a `tool_execution_end` with `isError: true` and
		// the rejection reason as result content. Drive the reducer with
		// that synthetic event.
		fake.emit(
			ev_toolExecEnd("call-deny-1", "write", {
				isError: true,
				result: { content: [{ type: "text", text: "User declined." }] },
			}),
		);

		// Assert *before* `agent_end` so the explicit-event path is
		// pinned in isolation: `applyToolResult` must populate
		// `tool.error` with the rejection text. If a regression dropped
		// this path entirely, the subsequent `sweepPendingTools`
		// (triggered on `agent_end`) would write the generic
		// `"Tool execution interrupted"` instead — different string,
		// would fail this assertion.
		const fMid = await waitForFrame(setup, "User declined.");
		expect(fMid).toContain("User declined.");
		// Anchor on the tool name too — confirms the error is rendered
		// on the right tool part, not somewhere else (the rejection
		// reason is short and could collide if it appeared in chrome).
		expect(fMid).toMatch(/⚙\s*write/);

		// Close the turn. The sweep at `agent_end` uses `error ??
		// "Tool execution interrupted"`, so the already-set
		// "User declined." must survive — pins that the sweep doesn't
		// clobber a more specific reason on a regressed `??`.
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "aborted" })]));
		await setup.renderOnce();
		await Bun.sleep(30);
		const fAfter = setup.captureCharFrame();
		expect(fAfter).toContain("User declined.");
		expect(fAfter).not.toContain("Tool execution interrupted");
	});

	test("after rejection, next user prompt starts a fresh turn", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await seedSessionForToolStateMutation(setup, fake);
		await waitForFrame(setup, "ctrl+p commands");

		const confirm = getConfirmFn();
		if (!confirm) throw new Error("confirmFn not installed");
		const pending = confirm(denyRequest("call-deny-2"));
		fake.emit(
			ev_toolcallEnd("call-deny-2", "write", { path: "/tmp/deny-target.md" }),
		);

		await waitForFrame(setup, "Permission required");
		setup.mockInput.pressArrow("right");
		setup.mockInput.pressEnter();
		await pending;

		// Backend emits the synthetic error + agent_end on rejection.
		fake.emit(
			ev_toolExecEnd("call-deny-2", "write", {
				isError: true,
				result: { content: [{ type: "text", text: "User declined." }] },
			}),
		);
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "aborted" })]));
		await waitForFrame(setup, "ctrl+p commands");

		// Now drive a fresh user turn — Enter on a non-empty input must
		// dispatch (`store.isStreaming` is back to false, no stuck
		// approval panel, no pending tool sweeping in flight).
		await setup.mockInput.typeText("another");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(40);

		// The post-rejection prompt landed. `primeConversation` seeds
		// "seed" first to establish the sessionId; the second prompt
		// after rejection is "another". Order matters — both calls are
		// recorded, and the rejection itself doesn't show up in
		// `fake.calls.prompt` (only the user-initiated turns do).
		expect(fake.calls.prompt).toEqual(["seed", "another"]);
	});
});
