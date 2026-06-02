import { LOGIN_HELPER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * Connect-ChatGPT acceptance flow (real-worker-codex slice 8, ADR-0023): a
 * user opens Settings → Providers, sees ChatGPT disconnected, clicks Connect,
 * and — after the (stubbed) OAuth flow completes and Core persists the
 * credential — the row flips to Connected when the tab regains focus.
 *
 * Runs fully offline: Core's provider/login_start is pointed at the
 * login-helper stub (emits an authorize URL then credentials, no real :1455 /
 * OpenAI), and the stub's URL is about:blank so the real `window.open` in the
 * SPA navigates a harmless popup instead of the OpenAI auth page.
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
		// The SPA's default openUrl calls window.open(authorize_url). The
		// stub returns about:blank (via INKSTONE_LOGIN_STUB_URL below), so the
		// popup is harmless; stub window.open anyway to avoid popup churn.
		window.open = () => null;
	});

	await chat.goto();

	// Open Settings (the gear in the top-right controls).
	await page.getByRole("button", { name: "Settings" }).click();

	// Providers panel shows ChatGPT disconnected.
	const status = page.getByTestId("chatgpt-status");
	await expect(status).toHaveText("Disconnected");

	// Click Connect → Core runs provider/login_start (stub helper), the SPA
	// opens the authorize URL (stubbed no-op), and the helper emits
	// credentials ~100ms later which Core persists.
	await page.getByRole("button", { name: "Connect" }).click();

	// Returning to the tab re-queries provider/status. Poll by dispatching the
	// focus event until the row flips to Connected (helper persist + status
	// round-trip), bounded by the assertion timeout.
	await expect
		.poll(
			async () => {
				await page.evaluate(() =>
					window.dispatchEvent(new Event("focus")),
				);
				return status.textContent();
			},
			{ timeout: 10_000, intervals: [100, 200, 300, 500] },
		)
		.toBe("Connected");
});
