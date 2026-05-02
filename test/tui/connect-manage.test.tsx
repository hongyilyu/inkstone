/**
 * Connect dialog — disconnect / re-auth actions for Kiro.
 *
 * Covers:
 *   - selecting a connected Kiro row opens a Reconnect / Disconnect menu
 *   - picking Disconnect → confirming clears creds, toasts, and rehomes
 *     the active session onto the next connected provider (OpenRouter
 *     via the preload seed)
 *   - Disconnect when no other provider is connected: creds cleared, no
 *     rehome, warning toast tells the user to pick a new model manually
 *   - confirmed-disconnect when the disconnected provider is NOT the
 *     active one: no setModel call, toast uses the plain success variant
 *   - ESC on the manage menu (creds untouched)
 *   - `n` on the DialogConfirm (creds untouched — pins the guard)
 *
 * Kiro is the only owned-creds OAuth provider exercised here. OpenAI
 * Codex and OpenRouter share the same disconnect shape via their
 * respective `confirmAndDisconnect*` helpers; the Kiro paths are
 * representative.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	clearKiroCreds,
	saveKiroCreds,
} from "../../src/backend/persistence/auth";
import { openrouterProvider } from "../../src/backend/providers/openrouter";
import { FAKE_MODEL, makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

// Shape matches pi-kiro's `KiroCredentials` at runtime; the cast is
// scoped through a parameter-factory pattern (same approach used by
// `test/kiro-refresh.test.ts:27`) so Biome's `noExplicitAny` rule doesn't
// fire and TypeScript sees a precise shape.
function makeCreds() {
	return {
		access: "access-seed",
		refresh: "refresh-seed",
		clientId: "cid",
		clientSecret: "csec",
		expires: Date.now() + 60_000,
		region: "us-east-1",
	};
}

function seedKiroCreds(): void {
	saveKiroCreds(makeCreds() as Parameters<typeof saveKiroCreds>[0]);
}

/**
 * Navigate Ctrl+P → Connect → connected-Kiro row → opens the manage menu.
 * Shared setup used by every test below.
 *
 * Uses `waitForFrame` for every state transition so a slow CI host polls
 * longer rather than racing a fixed sleep. The single 30ms sleep between
 * the Connect frame appearing and typing into the fuzzy filter is
 * load-bearing: DialogSelect focuses its filter input inside a
 * `setTimeout(1)` (see `ui/dialog-select.tsx`), so typing immediately
 * lands on the prompt textarea behind the dialog instead. Matches the
 * same 30ms idiom used in `test/tui/dialogs.test.tsx`.
 */
async function openManageMenu(
	s: Awaited<ReturnType<typeof renderApp>>,
): Promise<void> {
	s.mockInput.pressKey("p", { ctrl: true });
	await waitForFrame(s, "Command Panel");
	await Bun.sleep(30);

	await s.mockInput.typeText("Connect");
	await waitForFrame(s, "Connect");

	s.mockInput.pressEnter();
	// "Providers" is the title of the DialogSelect opened by Connect.
	await waitForFrame(s, "Providers");
	await Bun.sleep(30);

	// Filter down to the Kiro row and Enter. Connected providers float
	// to the top (see DialogProvider.options sort), so the fuzzy filter
	// + Enter lands on the only Kiro entry.
	await s.mockInput.typeText("Kiro");
	await waitForFrame(s, "Amazon Kiro");
	s.mockInput.pressEnter();
}

beforeEach(() => {
	// Every test starts from a clean auth.json state; the auth module
	// caches in-memory so a prior test's `saveKiroCreds` would leak
	// into the next test's `isConnected()` read.
	clearKiroCreds();
});

afterEach(() => {
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
	clearKiroCreds();
});

describe("Connect dialog — manage actions", () => {
	test("selecting connected Kiro opens Reconnect/Disconnect menu", async () => {
		seedKiroCreds();
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await openManageMenu(setup);

		const f = await waitForFrame(setup, "Reconnect");
		expect(f).toContain("Reconnect");
		expect(f).toContain("Disconnect");
		// Manage-menu title is the provider displayName.
		expect(f).toContain("Amazon Kiro");
	});

	test("Disconnect of active Kiro rehomes session onto OpenRouter default", async () => {
		// OpenRouter is the preload's seeded connected provider (see
		// `test/preload.ts`), so it's the expected rehome target when
		// Kiro disconnects while Kiro is active. No spy needed — the
		// seed makes OpenRouter's `isConnected()` deterministic.
		seedKiroCreds();
		// Fake session reports Kiro as the active provider.
		const kiroModel = {
			...FAKE_MODEL,
			id: "claude-opus-4-7",
			provider: "kiro",
		};
		const fake = makeFakeSession({ model: kiroModel });
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await openManageMenu(setup);
		await waitForFrame(setup, "Disconnect");

		// Move from the first row (Reconnect) to the second (Disconnect)
		// and commit.
		setup.mockInput.pressArrow("down");
		setup.mockInput.pressEnter();

		// DialogConfirm title carries the provider displayName.
		await waitForFrame(setup, "Disconnect Amazon Kiro?");

		// Two-step confirm dialog — `y` commits the Confirm branch
		// without arrow navigation (see dialog-confirm.tsx).
		setup.mockInput.pressKey("y");
		await waitForFrame(setup, "Amazon Kiro disconnected");

		const { loadKiroCreds } = await import(
			"../../src/backend/persistence/auth"
		);
		expect(loadKiroCreds()).toBeUndefined();
		// Active-provider rehome: one setModel call with the OpenRouter
		// default, sourced from `findFirstConnectedProvider("kiro")`.
		expect(fake.calls.setModel.length).toBe(1);
		const rehomed = fake.calls.setModel[0];
		expect(rehomed).toBeDefined();
		if (!rehomed) throw new Error("rehomed model missing");
		expect(rehomed.provider).toBe("openrouter");
	});

	test("Disconnect of active Kiro with no other provider connected warns without rehoming", async () => {
		// Force OpenRouter "disconnected" too so the rehome chain finds
		// no fallback — pins the warning-toast branch. Without this
		// spy the preload-seeded OpenRouter key would light up the
		// rehome path.
		const openrouterSpy = spyOn(
			openrouterProvider,
			"isConnected",
		).mockReturnValue(false);

		try {
			seedKiroCreds();
			const kiroModel = {
				...FAKE_MODEL,
				id: "claude-opus-4-7",
				provider: "kiro",
			};
			const fake = makeFakeSession({ model: kiroModel });
			setup = await renderApp({ session: fake.factory });
			await setup.renderOnce();

			await openManageMenu(setup);
			const menuFrame = await waitForFrame(setup, "Disconnect");
			expect(menuFrame).toContain("Reconnect");

			setup.mockInput.pressArrow("down");
			setup.mockInput.pressEnter();
			const confirmFrame = await waitForFrame(setup, "Disconnect Amazon Kiro?");
			expect(confirmFrame).toContain("Disconnect Amazon Kiro?");

			setup.mockInput.pressKey("y");
			// Poll for either the toast OR the dialog clearing. Toast
			// body may be rendered on a follow-up frame so we give it
			// render cycles.
			let found = false;
			for (let i = 0; i < 40; i++) {
				await setup.renderOnce();
				const f = setup.captureCharFrame();
				if (f.includes("Pick a new model")) {
					found = true;
					break;
				}
				await Bun.sleep(25);
			}
			expect(found).toBe(true);

			const { loadKiroCreds } = await import(
				"../../src/backend/persistence/auth"
			);
			expect(loadKiroCreds()).toBeUndefined();
			// No rehome — OpenRouter is gated out by the stubbed isConnected.
			expect(fake.calls.setModel.length).toBe(0);
		} finally {
			openrouterSpy.mockRestore();
		}
	});

	test("Disconnect of non-active Kiro clears creds without rehoming", async () => {
		seedKiroCreds();
		// Default FAKE_MODEL.provider === "openrouter", so Kiro is NOT
		// the active provider — disconnect should clear creds but
		// leave the current model alone.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await openManageMenu(setup);
		await waitForFrame(setup, "Disconnect");

		setup.mockInput.pressArrow("down");
		setup.mockInput.pressEnter();
		await waitForFrame(setup, "Disconnect Amazon Kiro?");

		setup.mockInput.pressKey("y");
		await waitForFrame(setup, "Amazon Kiro disconnected");

		const { loadKiroCreds } = await import(
			"../../src/backend/persistence/auth"
		);
		expect(loadKiroCreds()).toBeUndefined();
		// No rehome — session's active provider was already OpenRouter.
		expect(fake.calls.setModel.length).toBe(0);
	});

	test("ESC on the manage menu closes cleanly without touching creds", async () => {
		seedKiroCreds();
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await openManageMenu(setup);
		await waitForFrame(setup, "Reconnect");

		setup.mockInput.pressEscape();
		// Poll until the manage-menu glyphs disappear rather than
		// guessing a sleep duration for the dialog-close transition.
		// ESC unwinds synchronously via the dialog's onClose, but the
		// Solid rendering cycle still needs a tick or two.
		for (let i = 0; i < 20; i++) {
			await setup.renderOnce();
			if (!setup.captureCharFrame().includes("Reconnect")) break;
			await Bun.sleep(25);
		}

		expect(setup.captureCharFrame()).not.toContain("Reconnect");
		expect(setup.captureCharFrame()).not.toContain("Disconnect");

		const { loadKiroCreds } = await import(
			"../../src/backend/persistence/auth"
		);
		// Creds untouched — ESC is a cancel, not a disconnect.
		expect(loadKiroCreds()).toBeDefined();
		expect(fake.calls.setModel.length).toBe(0);
	});

	test("`n` on Disconnect confirm leaves creds intact", async () => {
		seedKiroCreds();
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await openManageMenu(setup);
		await waitForFrame(setup, "Disconnect");

		setup.mockInput.pressArrow("down");
		setup.mockInput.pressEnter();
		await waitForFrame(setup, "Disconnect Amazon Kiro?");

		// `n` maps to onCancel → DialogConfirm promise resolves `false`
		// → `confirmed !== true` early return. Pins the guard so a
		// refactor that inverts the check (e.g. `!confirmed`) doesn't
		// silently conflate cancel + ESC with confirm.
		setup.mockInput.pressKey("n");
		// Poll for the confirm-dialog title to disappear rather than a
		// fixed sleep — cancel resolves synchronously but the ToastProvider
		// and dialog-stack unmount still need a tick.
		for (let i = 0; i < 10; i++) {
			await setup.renderOnce();
			if (!setup.captureCharFrame().includes("Disconnect Amazon Kiro?")) break;
			await Bun.sleep(25);
		}

		const { loadKiroCreds } = await import(
			"../../src/backend/persistence/auth"
		);
		expect(loadKiroCreds()).toBeDefined();
		expect(fake.calls.setModel.length).toBe(0);
	});
});
