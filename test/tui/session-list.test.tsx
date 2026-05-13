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
	listSessions,
	newId,
	updateSessionTitle,
	withTransaction,
} from "@backend/persistence/sessions";
import type { DisplayMessage } from "@bridge/view-model";
import type { generateSessionTitle } from "../../src/backend/agent";
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

function seedSession(preview: string, title = preview): string {
	const rec = createSessionRow({ agent: "reader" });
	const msg: DisplayMessage = {
		id: newId(),
		role: "user",
		parts: [{ type: "text", text: preview }],
	};
	withTransaction((tx) => {
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
		updateSessionTitle(tx, rec.id, title);
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

	test("Ctrl+N inside the panel moves selection down instead of closing", async () => {
		// `listSessions` orders by `desc(sessions.id)` (UUIDv7 = chrono),
		// so the more-recently-seeded row sits at index 0 and the initial
		// selection lands there. After one Ctrl+N press we expect the
		// selection to move to index 1 — pressing Enter then resumes the
		// FIRST-seeded session's content.
		const firstId = seedSession("first row content");
		seedSession("second row content");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, "first row content");

		// Second Ctrl+N inside the open panel: should move selection down,
		// NOT close. Pre-fix behavior closes the panel here.
		setup.mockInput.pressKey("n", { ctrl: true });
		await setup.renderOnce();
		await Bun.sleep(30);

		// Panel still open — both rows still rendered.
		const f = setup.captureCharFrame();
		expect(f).toContain("first row content");
		expect(f).toContain("second row content");

		// Confirm selection landed on index 1 by pressing Enter and
		// asserting the resumed session is the FIRST-seeded one (which
		// `desc(id)` ordering puts at index 1).
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(30);

		expect(fake.calls.setSessionId).toContain(firstId);
	});

	test("End past the viewport scrolls the panel to keep selection visible", async () => {
		// Seed enough rows to overflow any plausible viewport. Each
		// SessionListItem renders ~3 visual rows; panel chrome eats ~3
		// more. Harness default height is 30 (~9 visible rows). 50 seeds
		// × ~3 visual ≈ 150 rows — comfortably overflows.
		//
		// The test process's SQLite DB is shared across the whole `bun
		// test` run (preload sets up one tmp dir per process; no
		// per-test cleanup), so other tests' sessions may also exist
		// when this runs. The assertion is leftover-resilient: we read
		// `listSessions()` to find the absolute top row at panel-open
		// time and assert it has scrolled OFF-screen after End. Pre-fix
		// (no scroll-follow), End moves selection but the scrollbox
		// stays at the top, so the top row remains visible — assertion
		// fails.
		for (let i = 0; i < 50; i++) {
			seedSession(`session-${String(i).padStart(2, "0")}`);
		}

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		// Confirm the panel mounted with our seeds. `session-49` is the
		// newest seeded title, so it sits at or near index 0.
		await waitForFrame(setup, "session-49");

		// First row at panel-open = the newest session in the DB. After
		// End scrolls the viewport past it, this title (truncated to
		// fit) should no longer appear in the frame. Our 50 seeds are
		// the newest sessions in the DB at this point in the test run,
		// so `firstRowTitle` is one of `session-NN` — distinct enough
		// from leftover-test titles that a substring collision is
		// negligible.
		const all = listSessions();
		const firstRowTitle = all[0]?.title;
		expect(firstRowTitle).toBeTruthy();

		// `"END"` is the KeyCodes key (mock-keys.d.ts); a lowercase
		// `"end"` would send the literal three-letter string.
		setup.mockInput.pressKey("END");
		await setup.renderOnce();
		await Bun.sleep(30);

		expect(setup.captureCharFrame()).not.toContain(firstRowTitle as string);
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
		withTransaction((tx) => {
			appendDisplayMessage(tx, rec.id, userMsg);
			appendAgentMessage(tx, rec.id, {
				role: "user",
				content: ":q",
				timestamp: Date.now(),
			});
			updateSessionTitle(tx, rec.id, ":q");
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

	test("resume wipes dynamic sidebar sections from the previous session", async () => {
		// Seed a session to resume into, with a raw agent_message so
		// `restoreMessages` is called with content (matches the style
		// of the "Enter on a row resumes" case above).
		const rec = createSessionRow({ agent: "reader" });
		const seededMsg: DisplayMessage = {
			id: newId(),
			role: "user",
			parts: [{ type: "text", text: "target session" }],
		};
		withTransaction((tx) => {
			appendDisplayMessage(tx, rec.id, seededMsg);
			appendAgentMessage(tx, rec.id, {
				role: "user",
				content: "target session",
				timestamp: Date.now(),
			});
			updateSessionTitle(tx, rec.id, "target session");
		});

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// In the live session, emit an `update_sidebar` upsert to get a
		// section into `store.sidebarSections`.
		await setup.mockInput.typeText("live turn");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);
		fake.emit(ev_agentStart());
		fake.emit(ev_messageStart());
		fake.emit({
			type: "tool_execution_end",
			toolCallId: "sb-live",
			toolName: "update_sidebar",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: {
					operation: "upsert",
					id: "live-notes",
					title: "Live",
					content: "should vanish on resume",
				},
			},
			isError: false,
		});
		fake.emit(ev_messageEnd({ stopReason: "toolUse" }));
		fake.emit(ev_agentEnd([assistantMessage({ stopReason: "toolUse" })]));
		await waitForFrame(setup, "should vanish on resume");

		// Open the session list panel and resume the seeded row.
		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, "target session");
		await Bun.sleep(30);
		setup.mockInput.pressEnter();

		// Wait for the resume batch to settle. The sidebar section
		// from the live session should be gone — `resumeSession` sets
		// `sidebarSections = []` inside the batch.
		const start = Date.now();
		while (Date.now() - start < 1500) {
			await setup.renderOnce();
			if (!setup.captureCharFrame().includes("should vanish on resume")) {
				break;
			}
			await Bun.sleep(30);
		}
		expect(setup.captureCharFrame()).not.toContain("should vanish on resume");
		// Sanity: the resume actually happened.
		expect(fake.calls.restoreMessages.length).toBeGreaterThanOrEqual(1);
	});
});

describe("session title generation", () => {
	test("background title generation does not block prompt and updates sidebar", async () => {
		let resolveTitle: (title: string) => void = () => {};
		const titlePromise = new Promise<string>((resolve) => {
			resolveTitle = resolve;
		});
		const titleGenerator: typeof generateSessionTitle = async () =>
			titlePromise;

		const fake = makeFakeSession();
		setup = await renderApp({
			session: fake.factory,
			sessionTitleGenerator: titleGenerator,
			width: 120,
		});
		await setup.renderOnce();

		await setup.mockInput.typeText("please name this session");
		setup.mockInput.pressEnter();
		await setup.renderOnce();

		expect(fake.calls.prompt).toEqual(["please name this session"]);

		resolveTitle("Generated Sidebar Title");
		const f = await waitForFrame(setup, "Generated Sidebar Title");
		expect(f).toContain("Generated Sidebar Title");
	});

	test("resuming a titled session hydrates the sidebar title", async () => {
		seedSession("resume preview", "Persisted Resume Title");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.mockInput.pressKey("n", { ctrl: true });
		await waitForFrame(setup, "Persisted Resume Title");
		await Bun.sleep(30);

		setup.mockInput.pressEnter();
		const f = await waitForFrame(setup, "Persisted Resume Title");
		expect(f).toContain("Persisted Resume Title");
	});

	test("stale title completion does not overwrite a cleared session", async () => {
		let resolveTitle: (title: string) => void = () => {};
		const titlePromise = new Promise<string>((resolve) => {
			resolveTitle = resolve;
		});
		const titleGenerator: typeof generateSessionTitle = async () =>
			titlePromise;

		const fake = makeFakeSession();
		setup = await renderApp({
			session: fake.factory,
			sessionTitleGenerator: titleGenerator,
			width: 120,
		});
		await setup.renderOnce();

		await setup.mockInput.typeText("old session prompt");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		await setup.mockInput.typeText("/clear");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(50);

		resolveTitle("Stale Title");
		await Bun.sleep(50);
		await setup.renderOnce();

		expect(setup.captureCharFrame()).not.toContain("Stale Title");
		expect(fake.calls.clearSession).toBeGreaterThanOrEqual(1);
	});
});
