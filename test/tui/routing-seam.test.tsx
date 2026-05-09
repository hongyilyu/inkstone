/**
 * Routing seam — `dispatch` tool result triggers fork + resume.
 *
 * Per ADR 0007 + the grilling design tree (Q11 → C'.iii), when the
 * router's `dispatch` tool resolves the TUI:
 *   1. Calls `forkSession()` on the parent (router) session, seeding
 *      the user's first message into the child.
 *   2. Aborts the router's in-flight turn.
 *   3. Resumes into the child — `clearSession` → `selectAgent(target)`
 *      → `restoreMessages(...)` — the existing resume flow.
 *
 * This test scripts the events that pi-agent-core would emit for a
 * router turn:
 *   - User submits "whats in foo" on the open page (router-bound).
 *   - Router emits `tool_execution_end` with `result.details.agent = "reader"`.
 *
 * Asserts:
 *   - `forkSession` ran (a child session row exists with `parent_session_id`
 *     pointing at the router session).
 *   - `selectAgent("reader")` and `restoreMessages` fired on the fake.
 *   - Post-frame contains the fork-divider needle ("Routed from Router")
 *     above the seeded user message.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { getDb } from "@backend/persistence/db/client";
import { sessions } from "@backend/persistence/db/schema";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { eq } from "drizzle-orm";
import {
	assistantMessage,
	ev_agentEnd,
	ev_agentStart,
	ev_messageEnd,
	ev_messageStart,
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

describe("routing seam", () => {
	test("dispatch tool result forks into child + resumes Reader session", async () => {
		const fake = makeFakeSession({ agentName: "router" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// User submits a freeform message on the open page.
		const userText = "whats in foo seam needle";
		await setup.mockInput.typeText(userText);
		setup.mockInput.pressEnter();
		await setup.renderOnce();

		// Wait for the user bubble to render so the message has been
		// persisted (and store.messages[0] is populated for the seam to
		// pick up as the seed).
		await waitForFrame(setup, userText);

		// Capture parent (router) session id BEFORE the seam fires —
		// after dispatch resolves the active session swaps.
		const routerSid = setup.getAgent().session.getCurrentSessionId();
		expect(routerSid).not.toBeNull();

		// Script the router's turn: agent_start → message_start → fake
		// dispatch tool_execution_end → message_end → agent_end.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		const dispatchEvent: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "call-dispatch-1",
			toolName: "dispatch",
			result: {
				content: [{ type: "text", text: "→ reader" }],
				details: { agent: "reader" },
			},
			isError: false,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the reducer's `endEvt` shape
		} as any;
		fake.emit(dispatchEvent);
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		// The seam fires asynchronously (queueMicrotask) so the resume
		// happens after the reducer batch completes. Wait for the
		// divider — that needle only appears post-resume.
		const f = await waitForFrame(setup, "Routed from Router");
		expect(f).toContain("Routed from Router");
		expect(f).toContain(userText);

		// selectAgent fired with the right target.
		expect(fake.calls.selectAgent).toContain("reader");
		expect(fake.calls.restoreMessages.length).toBeGreaterThanOrEqual(1);

		// `continue()` fired so the child agent's first turn runs.
		// Without this, `restoreMessages` seeds state but the loop
		// stays idle — the user sees the divider + their message
		// then nothing until they press Esc. (This regression actually
		// shipped on the live binary before being caught: routing
		// succeeded, divider rendered, then Reader never spoke.)
		expect(fake.calls.continue).toBe(1);

		// `restoreMessages` ran TWICE: once inside resumeSession with
		// the loaded transcript (which `repairAlternation` had padded
		// with a synthesized aborted-assistant tail), then a SECOND
		// time with just the user message — stripping the synthesized
		// tail so `continue()`'s tail-role check (must be user or
		// tool-result) passes. The second call must be the user-only
		// shape; otherwise pi-agent-core's `continue()` throws
		// "Cannot continue from message role: assistant" and Reader
		// never speaks.
		expect(fake.calls.restoreMessages.length).toBe(2);
		const finalSeed = fake.calls.restoreMessages[1];
		expect(finalSeed?.length).toBe(1);
		expect(finalSeed?.[0]?.role).toBe("user");

		// `loadSession`'s interrupted-user repair stamps the seeded
		// user message with `interrupted: true` (it sees a tail user
		// with no real assistant reply and assumes the turn was
		// interrupted). The seam must clear that flag — otherwise
		// the user sees "[Interrupted by user]" under their message
		// the moment Reader starts streaming. (This regression
		// shipped: Image #5 in the live session showed the
		// interrupted footer below the routed user message.)
		const storeUser = setup
			.getAgent()
			.store.messages.find((m) => m.role === "user");
		expect(storeUser?.interrupted).not.toBe(true);

		// A child session was forked off the router. Verify via the DB
		// to pin the schema-level shape (parent FK pointing at the
		// router's own session row).
		const db = getDb();
		const childRows = db
			.select()
			.from(sessions)
			.where(eq(sessions.parentSessionId, routerSid as string))
			.all();
		expect(childRows.length).toBe(1);
		expect(childRows[0]?.agent).toBe("reader");
	});

	test("dispatch tool_execution_end with isError: true is a silent skip — no fork, no resume", async () => {
		// Per ADR 0007 / grilling Q5, the router's turn is sealed after
		// dispatch and misroute correction is a fresh open-page submit.
		// An `isError: true` event (LLM emitted "router" or an unknown
		// agent — dispatch's `execute()` throws and pi-agent-core wraps
		// it as a tool error) takes the same path: the seam silently
		// skips, leaving the user on the open-page-equivalent state.
		const fake = makeFakeSession({ agentName: "router" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await setup.mockInput.typeText("error needle");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await waitForFrame(setup, "error needle");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		const errorEvent: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "call-dispatch-err",
			toolName: "dispatch",
			result: {
				content: [
					{ type: "text", text: "dispatch: unknown agent 'nonexistent'" },
				],
			},
			isError: true,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub
		} as any;
		fake.emit(errorEvent);
		fake.emit(ev_messageEnd({ stopReason: "stop" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));

		// Wait long enough for any microtask to run if it were going to.
		await Bun.sleep(100);
		await setup.renderOnce();

		// No fork happened.
		expect(fake.calls.selectAgent).not.toContain("reader");
		expect(fake.calls.restoreMessages.length).toBe(0);

		// agent_end ran normally (pendingDispatch was never set), so
		// the prompt unlocks as usual.
		expect(setup.getAgent().store.isStreaming).toBe(false);
	});

	test("prompt stays locked between dispatch and agent_end", async () => {
		// Race regression guard. After `tool_execution_end` for
		// `dispatch` fires, pi-agent-core's loop continues running
		// (`message_end` + `agent_end` come next). During that window
		// the prompt MUST NOT unlock — without the lock a fast user
		// could submit a second message on the about-to-be-abandoned
		// router session.
		//
		// The lock is `sessionState.pendingDispatchChildId`:
		// `applyDispatchResult` stashes the child sid, `handleAgentEnd`
		// reads + clears it and triggers `resumeSession`. Until
		// `agent_end` fires, the resume hasn't started; the prompt's
		// `store.isStreaming` is whatever pi-agent-core last set
		// (which is `true` from `agent_start`).
		const fake = makeFakeSession({ agentName: "router" });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await setup.mockInput.typeText("race needle");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await waitForFrame(setup, "race needle");

		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		const dispatchEvent: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "call-dispatch-2",
			toolName: "dispatch",
			result: {
				content: [{ type: "text", text: "→ reader" }],
				details: { agent: "reader" },
			},
			isError: false,
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub for the reducer's `endEvt` shape
		} as any;
		fake.emit(dispatchEvent);
		fake.emit(ev_messageEnd({ stopReason: "stop" }));

		// At this synchronous point, dispatch has resolved and the
		// fork has happened, but agent_end has NOT yet fired. The
		// prompt is locked.
		expect(setup.getAgent().store.isStreaming).toBe(true);

		// Now agent_end fires — the resume runs synchronously inside
		// the same handler, swapping us into the child session.
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "stop" })]));
		await waitForFrame(setup, "Routed from Router");
		expect(setup.getAgent().store.isStreaming).toBe(false);
	});
});
