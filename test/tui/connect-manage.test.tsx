/**
 * Connect dialog — disconnect / re-auth actions for Kiro.
 *
 * Covers:
 *   - selecting a connected Kiro row opens a Reconnect / Disconnect menu
 *   - picking Disconnect → confirming clears creds, toasts, and rehomes
 *     the active session onto the Bedrock default when Bedrock is
 *     connected (the CI sandbox is — `hasAwsSharedConfig` sees the
 *     developer's ~/.aws/config)
 *   - confirmed-disconnect when the disconnected provider is NOT the
 *     active one: no setModel call, toast uses the plain success variant
 *
 * Bedrock credentials live outside Inkstone (~/.aws/, AWS_* env vars),
 * so a Bedrock-row manage menu is a deliberate non-feature. Only the
 * Kiro branch of `dialog-provider.tsx` is exercised here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clearKiroCreds,
	saveKiroCreds,
} from "../../src/backend/persistence/auth";
import { getProvider } from "../../src/backend/providers";
import { FAKE_MODEL, makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

// Shape matches pi-kiro's `KiroCredentials` at runtime; the `as` assertion
// is typed through a matching parameter-factory pattern (same approach used
// by `test/kiro-refresh.test.ts:27`) so Biome's `noExplicitAny` rule doesn't
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
 * Shared setup used by all three tests below.
 */
async function openManageMenu(
	s: Awaited<ReturnType<typeof renderApp>>,
): Promise<void> {
	s.mockInput.pressKey("p", { ctrl: true });
	await waitForFrame(s, "Command Panel");
	await Bun.sleep(30);

	await s.mockInput.typeText("Connect");
	await waitForFrame(s, "Connect");
	await Bun.sleep(30);

	s.mockInput.pressEnter();
	// "Providers" is the title of the DialogSelect opened by Connect.
	await waitForFrame(s, "Providers");
	await Bun.sleep(30);

	// Filter down to the Kiro row and Enter. Connected providers float
	// to the top (see DialogProvider.options sort), so the fuzzy filter
	// + Enter lands on the only Kiro entry.
	await s.mockInput.typeText("Kiro");
	await waitForFrame(s, "Amazon Kiro");
	await Bun.sleep(30);
	s.mockInput.pressEnter();
	await Bun.sleep(30);
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

	test("Disconnect of active Kiro rehomes session onto Bedrock default", async () => {
		// The rehome branch only fires when Bedrock is connected. This
		// test depends on the developer / CI machine having either a
		// `~/.aws/` config or an AWS_* env var. Assert that up front so
		// a host without Bedrock fails with a clear message instead of
		// "expected 1 setModel call, got 0".
		if (!getProvider("amazon-bedrock").isConnected()) {
			throw new Error(
				"Test requires Bedrock to be connected (needs ~/.aws/config or AWS_* env vars)",
			);
		}
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
		await Bun.sleep(30);
		setup.mockInput.pressEnter();

		// DialogConfirm title carries the provider displayName.
		await waitForFrame(setup, "Disconnect Amazon Kiro?");

		// Two-step confirm dialog — `y` commits the Confirm branch
		// without arrow navigation (see dialog-confirm.tsx).
		setup.mockInput.pressKey("y");
		await Bun.sleep(60);
		await setup.renderOnce();

		const { loadKiroCreds } = await import(
			"../../src/backend/persistence/auth"
		);
		expect(loadKiroCreds()).toBeUndefined();

		// Active-provider rehome: Bedrock's `isConnected()` is true in
		// the test sandbox (preload.ts leaves ~/.aws discovery to the
		// host; `hasAwsSharedConfig` returns true on any dev machine
		// with a ~/.aws/config, which CI provides). One setModel call
		// with the bedrock default.
		expect(fake.calls.setModel.length).toBe(1);
		const rehomed = fake.calls.setModel[0];
		expect(rehomed).toBeDefined();
		if (!rehomed) throw new Error("rehomed model missing");
		expect(rehomed.provider).toBe("amazon-bedrock");
	});

	test("Disconnect of non-active Kiro clears creds without rehoming", async () => {
		seedKiroCreds();
		// Default FAKE_MODEL.provider === "amazon-bedrock", so Kiro is
		// NOT the active provider — disconnect should clear creds but
		// leave the current model alone.
		const fake = makeFakeSession();
		setup = await renderApp({ session: fake.factory });
		await setup.renderOnce();

		await openManageMenu(setup);
		await waitForFrame(setup, "Disconnect");

		setup.mockInput.pressArrow("down");
		await Bun.sleep(30);
		setup.mockInput.pressEnter();
		await waitForFrame(setup, "Disconnect Amazon Kiro?");

		setup.mockInput.pressKey("y");
		await Bun.sleep(60);
		await setup.renderOnce();

		const { loadKiroCreds } = await import(
			"../../src/backend/persistence/auth"
		);
		expect(loadKiroCreds()).toBeUndefined();
		// No rehome — session's active provider was already Bedrock.
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
		await setup.renderOnce();
		await Bun.sleep(50);
		await setup.renderOnce();

		// Dialog stack cleared — no Reconnect/Disconnect in the frame.
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
		await Bun.sleep(30);
		setup.mockInput.pressEnter();
		await waitForFrame(setup, "Disconnect Amazon Kiro?");

		// `n` maps to onCancel → DialogConfirm promise resolves `false`
		// → `confirmed !== true` early return. Pins the guard so a
		// refactor that inverts the check (e.g. `!confirmed`) doesn't
		// silently conflate cancel + ESC with confirm.
		setup.mockInput.pressKey("n");
		await Bun.sleep(60);
		await setup.renderOnce();

		const { loadKiroCreds } = await import(
			"../../src/backend/persistence/auth"
		);
		expect(loadKiroCreds()).toBeDefined();
		expect(fake.calls.setModel.length).toBe(0);
	});
});
