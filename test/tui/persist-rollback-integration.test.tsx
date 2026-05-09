/**
 * `persist({ onSuccess })` rollback gate — driven through the real reducer.
 *
 * `test/persistence-failure.test.ts` pins the wrapper's policy axis at
 * the unit level (writer report dedup, onSuccess gating, multi-writer
 * rollback). These tests pin the *integration* — for the two highest-
 * value persist-first sites in the reducer, force the underlying tx to
 * fail mid-flight and assert that the store's already-rendered state
 * does NOT advance to the post-mutation shape.
 *
 * Failure injection: after `ensureSession()` has committed the session
 * row, but before the persist-first event fires, delete the session row.
 * FK cascade kills the message + parts rows; the next persist call's
 * INSERT-with-FK (parts → messages, agent_messages → sessions) trips a
 * foreign-key violation and the wrapper's catch swallows the throw —
 * `onSuccess` must be skipped.
 *
 * Sites covered:
 *   1. `stampAssistantBubbleMeta` (`reducer.ts:376`) — the original
 *      drift-fix motivator; 3-writer atomic block (meta + parts + raw
 *      AgentMessage). On `stopReason: "error"`, the store's `error`
 *      field is gated on tx success.
 *   2. `applyToolResult` (`reducer.ts:491`) — most concrete user-
 *      visible tool state in the persist-first family. On a successful
 *      `tool_execution_end`, the tool part's `state` flips to
 *      `"completed"` only on tx success; rollback keeps it `"pending"`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { getDb } from "@backend/persistence/db/client";
import { sessions } from "@backend/persistence/db/schema";
import { eq } from "drizzle-orm";
import {
	ev_agentStart,
	ev_messageEnd,
	ev_messageStart,
	ev_textDelta,
	ev_textStart,
	ev_toolcallEnd,
	ev_toolExecEnd,
	ev_toolExecStart,
	makeFakeSession,
} from "./fake-session";
import { renderApp, waitUntil } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	setup?.renderer.destroy();
	setup = undefined;
});

/** Force the next persist-first tx in the active session to fail. */
function dropActiveSessionRow(sid: string): void {
	getDb().delete(sessions).where(eq(sessions.id, sid)).run();
}

async function seedUserTurn(
	setup_: NonNullable<typeof setup>,
	text: string,
): Promise<void> {
	await setup_.mockInput.typeText(text);
	setup_.mockInput.pressEnter();
	await setup_.renderOnce();
	// `actions.prompt` calls `ensureSession()` synchronously inside the
	// persist-first user-bubble path, but `persist` swallows on failure
	// and the prompt is fire-and-forget. Wait until the session id is
	// committed before the test deletes it.
	await waitUntil(
		() => setup_.getAgent().session.getCurrentSessionId() !== null,
		{ message: "ensureSession did not commit a row" },
	);
}

describe("persist({ onSuccess }) rollback — driven through reducer", () => {
	test("stampAssistantBubbleMeta: store.error stays unset when tx fails", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "hi");

		const sid = setup.getAgent().session.getCurrentSessionId();
		expect(sid).not.toBeNull();

		// Drive the assistant boundary so a shell row exists in store.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_textStart());
		fake.emit(ev_textDelta("partial reply"));

		// Drop the session row from disk. `messages` cascades-deletes; the
		// `appendAgentMessage` writer in stampAssistantBubbleMeta's tx body
		// will trip the `agent_messages.session_id` FK.
		dropActiveSessionRow(sid as string);

		// `stopReason: "error"` triggers the `errorStr` branch — onSuccess
		// would write `store.messages[lastIdx].error = errorMessage`.
		fake.emit(
			ev_messageEnd({
				stopReason: "error",
				errorMessage: "provider 500",
			}),
		);

		const last =
			setup.getAgent().store.messages[
				setup.getAgent().store.messages.length - 1
			];
		expect(last?.role).toBe("assistant");
		// The store mutation must NOT have fired — error stays undefined.
		expect(last?.error).toBeUndefined();
		expect(last?.interrupted).toBeUndefined();
	});

	test("applyToolResult: tool part stays 'pending' when tx fails", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();
		await seedUserTurn(setup, "run a tool");

		const sid = setup.getAgent().session.getCurrentSessionId();
		expect(sid).not.toBeNull();

		// Drive a turn up to a pending tool call. The reducer pushes a
		// `tool` DisplayPart in `state: "pending"` on `toolcall_end`.
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit(ev_toolcallEnd("call-1", "read", { path: "/tmp/x" }));
		fake.emit(ev_toolExecStart("call-1", "read", { path: "/tmp/x" }));

		// Drop the session row before tool_execution_end. `messages` and
		// `parts` cascade-delete; the persist call's `finalizeDisplayMessageParts`
		// DELETE+INSERT on `parts.message_id` trips the FK.
		dropActiveSessionRow(sid as string);

		fake.emit(
			ev_toolExecEnd("call-1", "read", {
				isError: false,
				result: { content: [{ type: "text", text: "file contents" }] },
			}),
		);

		// Locate the tool part the same way the reducer does (tail-first
		// scan on the last assistant bubble). The `applyToolResult`
		// onSuccess would have flipped `state` → `"completed"`. Rollback
		// keeps it `"pending"`, matching what `/resume` would render.
		const msgs = setup.getAgent().store.messages;
		const lastAssistant = msgs[msgs.length - 1];
		expect(lastAssistant?.role).toBe("assistant");
		const toolPart = lastAssistant?.parts.find(
			(p) => p.type === "tool" && p.callId === "call-1",
		);
		expect(toolPart?.type).toBe("tool");
		if (toolPart?.type === "tool") {
			expect(toolPart.state).toBe("pending");
			expect(toolPart.error).toBeUndefined();
		}
	});
});
