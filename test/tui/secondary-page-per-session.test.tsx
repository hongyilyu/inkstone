/**
 * Per-session preservation of the secondary page across resume.
 * See `docs/ARCHITECTURE.md` § Per-session secondary page.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	appendAgentMessage,
	appendDisplayMessage,
	createSession as createSessionRow,
	newId,
	updateSessionTitle,
	withTransaction,
} from "@backend/persistence/sessions";
import type { DisplayMessage } from "@bridge/view-model";
import {
	__resetSecondaryPageForTesting,
	openSecondaryPage,
} from "../../src/tui/context/secondary-page";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	__resetSecondaryPageForTesting();
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

/** Mirrors the helper in `prompt-draft.test.tsx`. */
function seedSession(preview: string, title = preview): string {
	const rec = createSessionRow({ agent: "reader" });
	const msg: DisplayMessage = {
		id: newId(),
		role: "user",
		parts: [{ type: "text", text: preview }],
	};
	withTransaction((tx) => {
		appendDisplayMessage(tx, rec.id, msg);
		appendAgentMessage(tx, rec.id, {
			role: "user",
			content: preview,
			timestamp: Date.now(),
		});
		updateSessionTitle(tx, rec.id, title);
	});
	return rec.id;
}

describe("secondary page per-session storage", () => {
	test("switching session A → B → A re-displays A's open page automatically", async () => {
		const sidA = seedSession("alpha-preview", "Session A");
		const sidB = seedSession("beta-preview", "Session B");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(20);
		openSecondaryPage({ content: "# Session A Page", title: "a-page" });
		await waitForFrame(setup, "Session A Page");

		setup.getAgent().actions.resumeSession(sidB);
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("Session A Page");

		setup.getAgent().actions.resumeSession(sidA);
		await waitForFrame(setup, "Session A Page");
	});

	test("closeSecondaryPage drops the current session's stored page", async () => {
		const sidA = seedSession("close-preview", "Session A");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(20);

		openSecondaryPage({ content: "# Closing Page", title: "c-page" });
		await waitForFrame(setup, "Closing Page");

		// closeSecondaryPage clears the slot, not just the view: the
		// re-resume below must NOT resurrect the page.
		setup.mockInput.pressEscape();
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("Closing Page");

		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(30);
		await setup.renderOnce();
		expect(setup.captureCharFrame()).not.toContain("Closing Page");
	});
});
