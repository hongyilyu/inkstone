import { LOGIN_HELPER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Connect-ChatGPT acceptance flow (real-worker-codex slice 8, ADR-0023/0024): a
 * user opens Settings → Models, sees ChatGPT not connected, clicks Connect,
 * and — after the (stubbed) OAuth flow completes and Core persists the
 * credential — the provider card flips to Connected when the tab regains focus.
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
	// credentials ~100ms later which Core persists.
	await page.getByRole("button", { name: "Connect" }).click();

	// Returning to the tab re-queries provider/status. Poll by dispatching the
	// focus event until the card flips to Connected (helper persist + status
	// round-trip), bounded by the assertion timeout.
	await expect
		.poll(
			async () => {
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				return status.textContent();
			},
			{ timeout: 10_000, intervals: [100, 200, 300, 500] },
		)
		.toBe("Connected");
});
