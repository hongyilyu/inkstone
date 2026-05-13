/**
 * Prompt-draft preservation across navigation seams.
 *
 * Bug surface: typing into the prompt and then navigating into a
 * full-screen secondary page (or switching to another session via
 * the session list) destroyed the unmounted Prompt's local state —
 * `text` signal + textarea extmarks (where `@`-mentions live). On
 * return the user found an empty prompt.
 *
 * Fix: per-session draft slot, hoisted out of the Prompt's
 * component-local lifetime into a module signal in
 * `src/tui/context/prompt-draft.ts`. Snapshot on unmount and on
 * session-switch; restore on mount and on switch back.
 *
 * Process-lifetime only — quitting Inkstone discards drafts. Open
 * page (no session bound, `currentSessionId === null`) gets no
 * preservation: there's nowhere meaningful to round-trip from.
 *
 * Tests cover the three navigation surfaces that don't *commit* the
 * draft (secondary-page round-trip, session switch round-trip,
 * mid-roundtrip slot isolation), plus the post-submit clear and the
 * mention-style preservation.
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
import { __resetDraftsForTesting } from "../../src/tui/context/prompt-draft";
import {
	closeSecondaryPage,
	openSecondaryPage,
} from "../../src/tui/context/secondary-page";
import { __resetSecondaryPageHistoryForTesting } from "../../src/tui/context/secondary-page-history";
import { makeFakeSession } from "./fake-session";
import { renderApp } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	__resetSecondaryPageHistoryForTesting();
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
	// Reset the module-level draft signal so a slot written by one
	// test (e.g. a snapshot fired during `renderer.destroy()`) doesn't
	// leak into the next. Tests use process-fresh session ids today
	// so leakage is a latent issue, but pinning isolation now keeps a
	// future test reorder from breaking things in subtle ways.
	__resetDraftsForTesting();
});

/**
 * Persist a session row with one user/assistant message pair so
 * `loadSession` returns a real, non-empty session for the resume path.
 * Mirrors the helper from `session-list.test.tsx:42` — replicated
 * inline here because it's the second-or-third caller pattern this
 * codebase already uses (see CLAUDE.md "factor out on second consumer").
 */
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

/**
 * Push the current input through the textarea ref. Mirrors what
 * `mockInput.typeText` does, but skips the per-char delay so tests
 * that just want to populate the buffer don't pay 8ms per keystroke
 * waiting for the renderer.
 */
async function setBuffer(
	setup_: Awaited<ReturnType<typeof renderApp>>,
	text: string,
): Promise<void> {
	const input = setup_.getLayout().getInputRef();
	if (!input) throw new Error("setBuffer: input ref not yet mounted");
	input.setText(text);
	await setup_.renderOnce();
}

describe("prompt draft preservation", () => {
	test("t1: secondary-page roundtrip preserves typed text", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		// Commit a session first so the prompt is bound to a sessionId.
		// Without this `currentSessionId` stays null (open page) and the
		// hook intentionally skips slot read/write — covered by t5.
		await setup.mockInput.typeText("seed");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		// Type a draft we expect to survive the roundtrip.
		await setBuffer(setup, "hello world");

		openSecondaryPage({ content: "# Article", title: "x" });
		await setup.renderOnce();
		await Bun.sleep(20);
		closeSecondaryPage();
		await setup.renderOnce();
		await Bun.sleep(20);

		// On return, the textarea must be restored.
		const input = setup.getLayout().getInputRef();
		expect(input?.plainText).toBe("hello world");
	});

	test("t2: secondary-page roundtrip preserves @-mention extmark data", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("seed");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		// Insert "see @foo.md" with a virtual extmark over `@foo.md`,
		// matching what `prompt-autocomplete.tsx` does on selection.
		const input = setup.getLayout().getInputRef();
		if (!input) throw new Error("input not mounted");
		input.setText("see @foo.md ");
		// `registerType` returns the same id for the same name across
		// re-registrations within the renderable lifetime — Prompt's
		// ref-callback registered "prompt-mention" on mount; calling it
		// again returns that same id.
		const typeId = input.extmarks.registerType("prompt-mention");
		input.extmarks.create({
			start: 4,
			end: 4 + Bun.stringWidth("@foo.md"),
			virtual: true,
			typeId,
			metadata: { path: "foo.md" },
		});
		await setup.renderOnce();

		openSecondaryPage({ content: "# Article" });
		await setup.renderOnce();
		await Bun.sleep(20);
		closeSecondaryPage();
		await setup.renderOnce();
		await Bun.sleep(20);

		const restored = setup.getLayout().getInputRef();
		expect(restored?.plainText).toBe("see @foo.md ");
		const marks = restored?.extmarks.getAllForTypeId(typeId) ?? [];
		expect(marks.length).toBe(1);
		const meta = marks[0]
			? restored?.extmarks.getMetadataFor(marks[0].id)
			: undefined;
		expect(meta?.path).toBe("foo.md");
	});

	test("t3: switching sessions preserves each session's draft", async () => {
		const sidA = seedSession("session-a-preview", "Session A");
		const sidB = seedSession("session-b-preview", "Session B");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Resume into A and type a draft.
		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(20);
		await setBuffer(setup, "alpha");

		// Switch to B; A's draft must be snapshotted. B inherits an
		// empty buffer (no slot yet).
		setup.getAgent().actions.resumeSession(sidB);
		await setup.renderOnce();
		await Bun.sleep(20);
		expect(setup.getLayout().getInputRef()?.plainText).toBe("");
		await setBuffer(setup, "beta");

		// Switch back to A; A's draft must be restored.
		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(20);
		expect(setup.getLayout().getInputRef()?.plainText).toBe("alpha");

		// Switch to B again; B's draft must still be there.
		setup.getAgent().actions.resumeSession(sidB);
		await setup.renderOnce();
		await Bun.sleep(20);
		expect(setup.getLayout().getInputRef()?.plainText).toBe("beta");
	});

	test("t4: submit clears only the current session's slot", async () => {
		const sidA = seedSession("session-a-preview", "Session A");
		const sidB = seedSession("session-b-preview", "Session B");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Pre-stuff B's slot by typing in B and switching away.
		setup.getAgent().actions.resumeSession(sidB);
		await setup.renderOnce();
		await Bun.sleep(20);
		await setBuffer(setup, "beta");

		// Move to A and submit. B's slot must remain.
		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(20);
		await setBuffer(setup, "alpha");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(30);

		// A's prompt is now empty (slot cleared on submit).
		expect(setup.getLayout().getInputRef()?.plainText).toBe("");

		// Switch to B; the pre-stuffed draft survives.
		setup.getAgent().actions.resumeSession(sidB);
		await setup.renderOnce();
		await Bun.sleep(20);
		expect(setup.getLayout().getInputRef()?.plainText).toBe("beta");

		// Sanity: switching back to A still shows empty (the slot was
		// truly cleared, not just shadowed by the live textarea state).
		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(20);
		expect(setup.getLayout().getInputRef()?.plainText).toBe("");
	});

	test("t5: open-page draft is transient (not preserved when leaving)", async () => {
		const sid = seedSession("session-preview", "Session X");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		// Open page: type a draft. `currentSessionId` is still null
		// because no prompt has committed.
		await setBuffer(setup, "open-page idea");

		// Resume into a real session — this is the "leave open page"
		// surface. By design there's nowhere to return to that would
		// preserve the open-page draft.
		setup.getAgent().actions.resumeSession(sid);
		await setup.renderOnce();
		await Bun.sleep(20);
		await setBuffer(setup, "in-session text");

		// Clear back to open page.
		await setup.getAgent().actions.clearSession();
		await setup.renderOnce();
		await Bun.sleep(30);

		// Open-page prompt is empty: the previous draft was not
		// preserved across the session-list jaunt.
		expect(setup.getLayout().getInputRef()?.plainText).toBe("");
	});

	test("t6: switching back to a session with mentions does not duplicate them", async () => {
		// Pins a subtle reactivity bug: `getDraft` reads the
		// module-level `drafts` signal. Without `untrack`, Solid
		// registers it as a dependency of the switch effect, so the
		// `setDraft` we fire in the snapshot branch immediately
		// re-runs the effect — and since `lastSeenSid === sid` on the
		// re-run, the snapshot path is skipped but `applyDraft` runs a
		// second time, creating duplicate extmarks. Plain text drafts
		// (t3) hide this because the second `setText` is idempotent;
		// the duplication only surfaces when the restored slot has
		// mentions.
		const sidA = seedSession("session-a-preview", "Session A");
		const sidB = seedSession("session-b-preview", "Session B");

		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory, width: 120 });
		await setup.renderOnce();

		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(20);

		// Type "see @foo.md" with a mention extmark on session A.
		const inputA = setup.getLayout().getInputRef();
		if (!inputA) throw new Error("input not mounted");
		const typeId = inputA.extmarks.registerType("prompt-mention");
		inputA.setText("see @foo.md ");
		inputA.extmarks.create({
			start: 4,
			end: 4 + Bun.stringWidth("@foo.md"),
			virtual: true,
			typeId,
			metadata: { path: "foo.md" },
		});
		await setup.renderOnce();

		// Switch away (snapshot fires) and back (restore fires).
		setup.getAgent().actions.resumeSession(sidB);
		await setup.renderOnce();
		await Bun.sleep(20);
		setup.getAgent().actions.resumeSession(sidA);
		await setup.renderOnce();
		await Bun.sleep(20);

		const restored = setup.getLayout().getInputRef();
		const restoredMarks = restored?.extmarks.getAllForTypeId(typeId) ?? [];
		// One mention, not two — the restore must not double-fire.
		expect(restoredMarks.length).toBe(1);
		expect(restored?.plainText).toBe("see @foo.md ");
	});

	test("t7: restored mention extmark carries the file styleId", async () => {
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await setup.mockInput.typeText("seed");
		setup.mockInput.pressEnter();
		await setup.renderOnce();
		await Bun.sleep(20);

		const input = setup.getLayout().getInputRef();
		if (!input) throw new Error("input not mounted");
		const typeId = input.extmarks.registerType("prompt-mention");
		input.setText("ref @foo.md ");
		input.extmarks.create({
			start: 4,
			end: 4 + Bun.stringWidth("@foo.md"),
			virtual: true,
			typeId,
			metadata: { path: "foo.md" },
		});
		await setup.renderOnce();
		const beforeMarks = input.extmarks.getAllForTypeId(typeId);
		expect(beforeMarks.length).toBe(1);

		openSecondaryPage({ content: "# Article" });
		await setup.renderOnce();
		await Bun.sleep(20);
		closeSecondaryPage();
		await setup.renderOnce();
		await Bun.sleep(20);

		const restored = setup.getLayout().getInputRef();
		const restoredMarks = restored?.extmarks.getAllForTypeId(typeId) ?? [];
		expect(restoredMarks.length).toBe(1);
		// The hook resolves `extmark.file` against the active syntax
		// style and stamps it onto the replayed mark — proving the
		// file-highlight color survives the round-trip even when the
		// snapshot doesn't carry the styleId itself (mentions are
		// stored as `{start, end, path}`, the styleId is re-resolved
		// at restore time so a theme switch picks up the right value).
		expect(restoredMarks[0]?.styleId).toBeDefined();
		expect(typeof restoredMarks[0]?.styleId).toBe("number");
	});
});
