/**
 * Session list panel (Ctrl+N).
 *
 * Covers:
 *   - Ctrl+N opens the panel
 *   - pre-seeded sessions appear as rows
 *   - Enter resumes the selected session
 *   - ESC closes the panel
 *   - narrow terminal shows a toast instead of the panel
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	appendAgentMessage,
	appendDisplayMessage,
	createSession as createSessionRow,
	newId,
	runInTransaction,
} from "@backend/persistence/sessions";
import type { DisplayMessage } from "@bridge/view-model";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

function seedSession(preview: string): string {
	const rec = createSessionRow({ agent: "reader" });
	const msg: DisplayMessage = {
		id: newId(),
		role: "user",
		parts: [{ type: "text", text: preview }],
	};
	runInTransaction((tx) => {
		appendDisplayMessage(tx, rec.id, msg);
		// Also seed a raw agent_message so `loaded.agentMessages` is
		// non-empty. Otherwise resume calls `restoreMessages([])`
		// which is correct behavior but not the "has-content" case
		// the test wants to verify.
		appendAgentMessage(tx, rec.id, {
			role: "user",
			content: preview,
			timestamp: Date.now(),
		});
	});
	return rec.id;
}

describe("session list panel", () => {
	test("Ctrl+N opens the panel listing seeded sessions", async () => {
		seedSession("hello from seeded session A");
		seedSession("another session B preview line");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		// Panel mounts; preview lines appear (truncated to ~30 chars
		// per row, but the leading chunk is stable).
		const f = await waitForFrame(setup, "hello from seeded session A");
		expect(f).toContain("hello from seeded session A");
		expect(f).toContain("another session B preview");
	});

	test("narrow terminal warns instead of opening", async () => {
		const fake = makeFakeSession();
		// Under 80 cols → the session_list command shows a toast.
		setup = await renderApp({ session: fake.factory, width: 70 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		const f = await waitForFrame(setup, "Terminal too narrow");
		expect(f).toContain("Widen the window");
	});

	test("ESC closes the panel", async () => {
		seedSession("close me");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, "close me");

		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();

		// Panel gone — `close me` is only rendered in the panel row.
		expect(setup.captureCharFrame()).not.toContain("close me");
	});

	test("Enter on a row resumes the session with its messages", async () => {
		seedSession("first choice");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, "first choice");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(30);

		// Resume flow calls `restoreMessages` on the session with the
		// persisted raw AgentMessage list. Assert non-empty so a
		// regression that swallows `loaded.agentMessages` (e.g. passes
		// `[]`) would fail here.
		expect(fake.calls.restoreMessages.length).toBeGreaterThanOrEqual(1);
		const restored = fake.calls.restoreMessages[0];
		expect(restored).toBeDefined();
		expect(restored!.length).toBeGreaterThanOrEqual(1);
	});

	test("resume mid-stream toasts `Session busy` and does not reload", async () => {
		seedSession("blocked resume");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Start streaming: submit a prompt and emit agent_start.
		await setup.mockInput.typeText("go");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		fake.emit({ type: "agent_start" });
		await setup.renderOnce();

		// Try to open the session list and resume.
		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, "blocked resume");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		await setup.renderOnce();

		const f = await waitForFrame(setup, "Session busy");
		expect(f).toContain("Session busy");
		// restoreMessages must NOT have been called — the reducer
		// short-circuits before the load.
		expect(fake.calls.restoreMessages.length).toBe(0);
	});

	test("dangling user message renders [Interrupted by user] on resume", async () => {
		// Seed a session where the last agent_message is `role: "user"`.
		// `loadSession`'s tail repair synthesizes a placeholder aborted
		// assistant so the provider alternation stays valid, and the
		// user-bubble renderer shows a muted `[Interrupted by user]`
		// marker because the next DisplayMessage (the synthesized
		// assistant) has empty parts and no error.
		const rec = createSessionRow({ agent: "reader" });
		const userMsg: DisplayMessage = {
			id: newId(),
			role: "user",
			parts: [{ type: "text", text: ":q" }],
		};
		runInTransaction((tx) => {
			appendDisplayMessage(tx, rec.id, userMsg);
			appendAgentMessage(tx, rec.id, {
				role: "user",
				content: ":q",
				timestamp: Date.now(),
			});
		});

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, ":q");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		// Resume flow runs inside a batch; give it a tick to settle.
		await waitForFrame(setup, "Interrupted by user");
	});
});
