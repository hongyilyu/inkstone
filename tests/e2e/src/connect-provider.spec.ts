import { expect, test } from "./fixtures.js";
import { LOGIN_HELPER_CMD } from "./spawnCore.js";

/**
 * Connect-ChatGPT acceptance flow (real-worker-codex slice 8, ADR-0023/0024;
 * live-push slice, ADR-0047/0049): a user opens Settings → Models, sees ChatGPT
 * not connected, clicks Connect, and — after the (stubbed) OAuth flow completes
 * and Core persists the credential — the provider card flips to Connected from
 * the live `provider/connected` push ALONE, without the tab regaining focus.
 *
 * Core frames `provider/connected` onto the originating connection when the
 * detached credential-drain task persists the rotated creds (ADR-0049); the
 * Models page registers a by-method handler that refetches `provider/status`, so
 * the card flips live. This spec asserts that flip with NO synthetic `window`
 * `focus` event and no reload — the push is the only thing that can flip the
 * card here, so a build without it would hang to timeout (RED).
 *
 * Runs fully offline: Core's provider/login_start is pointed at the
 * login-helper stub (emits an authorize URL then credentials, no real :1455 /
 * OpenAI), and the SPA's `window.open` is stubbed to a no-op.
 */
test.use({
	coreOptions: {
		providerLoginCmd: LOGIN_HELPER_CMD,
	},
});

test("Settings → Connect ChatGPT flips to Connected after login", async ({
	chat,
	page,
}) => {
	// Make the real window.open target harmless in headless Chromium.
	await page.addInitScript(() => {
		window.open = () => null;
	});

	await chat.goto();

	// Open Settings (the gear navigates to the /settings/models route).
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

	// The provider card shows ChatGPT not connected.
	const status = page.getByTestId("provider-status");
	await expect(status).toHaveText("Not connected");

	// Click Connect → Core runs provider/login_start (stub helper), the SPA
	// opens the authorize URL (stubbed no-op), and the helper emits
	// credentials ~100ms later which Core persists. On persist, Core frames
	// `provider/connected` onto this connection; the Models page's handler
	// refetches `provider/status` and the card flips — no focus, no reload.
	await page.getByRole("button", { name: "Connect" }).click();

	// The card flips to Connected from the live push alone (ADR-0049). No
	// synthetic `window 'focus'` dispatch: the push is the sole signal.
	await expect(status).toHaveText("Connected", { timeout: 10_000 });
});
