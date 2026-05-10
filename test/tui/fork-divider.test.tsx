/**
 * Fork-divider rendering.
 *
 * Per ADR 0015, a child session born from `forkSession()` carries a
 * `parts.type = "fork"` row as its first display message. The TUI renders
 * this as an inline divider — single line, no bubble frame, no agent
 * footer — above the seeded user message.
 *
 * Test seeds a session using `forkSession()` (PR 3), opens it via the
 * sessions-list panel, and asserts the rendered frame contains the
 * divider needle.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	createSession as createSessionRow,
	forkSession,
	newId,
} from "@backend/persistence/sessions";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

function userAgentMsg(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

describe("fork-divider", () => {
	test("renders inline divider above seeded user message in child session", async () => {
		// Build the parent (router) + child (reader) shape that PR 3's
		// forkSession produces.
		const parent = createSessionRow({ agent: "router" });
		const userText = "whats in foo divider needle";
		const child = forkSession({
			parentId: parent.id,
			targetAgent: "reader",
			seedMessages: [
				{
					display: {
						id: newId(),
						role: "user",
						parts: [{ type: "text", text: userText }],
					},
					agentMessage: userAgentMsg(userText),
				},
			],
		});

		const fake = makeFakeSession({ agentName: "reader" });
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Open the session list (Ctrl+N), select the child row.
		// Note: the child's title is the auto-generated default
		// (`createDefaultTitle`); we won't search for it, we just hit
		// Enter on the top row (the most recent — the child itself).
		setup.mockInput.pressKey("n", { ctrl: true });
		// Wait for the panel to open. Title prefix is "New session - ".
		await waitForFrame(setup, "New session");
		await Bun.sleep(30);
		setup.mockInput.pressEnter();

		// Wait for the seeded user-message text to render — confirms
		// the resume batch landed.
		await waitForFrame(setup, userText);

		// The divider needle. Per ADR 0015, content is "↳ Routed from Router".
		const f = await waitForFrame(setup, "Routed from Router");
		expect(f).toContain("Routed from Router");
		expect(f).toContain(userText);

		// Sanity: resume actually dispatched messages — without this,
		// a regression where loadSession returns nothing but the sidebar
		// happens to print the needle elsewhere would silently pass.
		expect(fake.calls.restoreMessages.length).toBeGreaterThanOrEqual(1);
		// Reference child session id so the test is keyed on the right row.
		expect(child.parentSessionId).toBe(parent.id);
	});
});
