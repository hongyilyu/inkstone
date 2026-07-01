import { expect, test } from "./fixtures.js";
import {
	PROVIDER_HELPER_FIXTURE_BIN,
	WORKER_FIXTURE_BIN,
} from "./spawnCore.js";

/**
 * Compiled Provider Helper, auto-detected end-to-end (ADR-0041, slice 4).
 *
 * Mirrors connect-provider.spec.ts's browser flow (Settings → Connect ChatGPT →
 * card flips to Connected), but instead of pointing `provider/login_start` at a
 * `tsx` fixture via `providerLoginCmd` (INKSTONE_PROVIDER_LOGIN_CMD), it uses the
 * hermetic sibling mode with NO override: Core is booted from an isolated tempdir
 * with a compiled `inkstone-provider-helper` sitting NEXT TO its own executable.
 * The only way the card can flip to Connected is Core's ADR-0041 step-2 sibling
 * auto-detection (shipped slice 2: ProviderLogin → `inkstone-provider-helper
 * login`) firing on `current_exe`'s directory, spawning the sibling, and
 * persisting the credentials it emits.
 *
 * The sibling is the bun-compiled `login-helper.ts` FIXTURE (emits authorize_url
 * then credentials offline — no real :1455 / OpenAI), compiled by global-setup to
 * a NON-real name and copied to the real `inkstone-provider-helper` name only
 * inside the per-test tempdir (never `target/debug/inkstone-provider-helper`,
 * which would hijack real `provider/login_start` in dev). `spawnCore`'s sibling
 * mode forwards INKSTONE_LOGIN_STUB_URL=about:blank to the spawned Core (and thus
 * to the helper child), so the SPA's `window.open(authorize_url)` is harmless in
 * headless Chromium; `window.open` is additionally stubbed to a no-op.
 *
 * A worker sibling is provided too so the tempdir Core is fully self-sufficient,
 * though login never spawns a worker.
 */
test.use({
	coreOptions: {
		siblingBinaries: {
			providerHelper: PROVIDER_HELPER_FIXTURE_BIN,
			worker: WORKER_FIXTURE_BIN,
		},
	},
});

test("Core auto-detects + spawns a sibling provider-helper binary; ChatGPT flips to Connected", async ({
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

	// The provider card shows ChatGPT not connected. There are now TWO provider
	// rows (OpenAI/codex + OpenRouter, ADR-0062), so scope the status to the
	// OpenAI row (its drill-in button is named "Open OpenAI models") — an
	// unscoped getByTestId would strict-mode-fail across both rows.
	const status = page
		.getByRole("button", { name: "Open OpenAI models" })
		.locator("xpath=..")
		.getByTestId("provider-status");
	await expect(status).toHaveText("Not connected");

	// Click Connect → Core runs provider/login_start. With no override set, Core
	// auto-detects the sibling `inkstone-provider-helper` and spawns it
	// (`login`); the compiled fixture emits an authorize URL (about:blank, opened
	// as a no-op) then credentials ~100ms later which Core persists.
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
