import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * OpenRouter provider acceptance flow (ADR-0062): against a real Core + faux
 * Worker, a user configures OpenRouter with a pasted key (the row flips to
 * Connected) and then runs a liveness Test on the now-configured provider (the
 * indicator shows "Working") — all through the same surfaces a user touches.
 *
 * The default Core seeds ONLY an `openai-codex` OAuth credential, so OpenRouter
 * starts NOT configured — exactly the precondition the Configure flow needs.
 * `provider/status` lists OpenRouter because slice 2/3 added it to the catalog.
 *
 * Runs fully offline: `workerCmd: FAUX_WORKER_CMD` points Core's per-Run Worker
 * (which the liveness probe spawns as an ephemeral one-shot) at the env-scripted
 * faux interpreter, and `fauxResponse: "pong"` makes it emit a text token. The
 * probe collects the first token → alive → "Working". The faux worker ignores
 * the manifest's provider/model + the resolved key entirely (it's offline), so
 * the configured OpenRouter key only needs to *resolve* (which it does after the
 * Configure write) for the probe to spawn.
 *
 * ADR-0062's no-persistence property (the Test creates no Thread/Run/message) is
 * asserted here via the UI: the sidebar thread count stays 0 after the Test. The
 * Core-level row-count invariant is already unit-pinned in slice 4's
 * provider_test.rs; this spec observes the lighter user-visible property.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxResponse: "pong",
	},
});

test("Settings → configure OpenRouter flips to Connected, then Test shows Working", async ({
	chat,
	page,
}) => {
	await chat.goto();

	// No threads yet — the baseline the no-persistence assertion compares against.
	expect(await chat.threadCount()).toBe(0);

	// Open Settings → Models (the gear navigates to /settings/models).
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

	// The OpenRouter row is present and Not connected. There are now TWO provider
	// rows (the seeded OpenAI/codex + OpenRouter), so scope the status assertion
	// to OpenRouter's row (its drill-in button is named "Open OpenRouter models").
	const openrouterRow = page
		.getByRole("button", { name: "Open OpenRouter models" })
		.locator("xpath=..");
	await expect(openrouterRow.getByTestId("provider-status")).toHaveText(
		"Not connected",
	);

	// Click OpenRouter's Configure control. It's the sole Configure affordance:
	// codex is OAuth (offers "Connect") and is already connected (offers nothing),
	// so only OpenRouter's key-configure button renders.
	await page.getByRole("button", { name: "Configure" }).click();

	// Paste a key into the form and Save → real provider/configure writes the 0600
	// ApiKey credential, then Core re-reads provider/status and the row flips live.
	await page.getByLabel("API key").fill("sk-or-test-key");
	await page.getByRole("button", { name: "Save" }).click();

	// The OpenRouter row flips to Connected (no reload) via the shared
	// applyStatus chokepoint the configure success routes through.
	await expect(openrouterRow.getByTestId("provider-status")).toHaveText(
		"Connected",
		{ timeout: 10_000 },
	);

	// Drill into OpenRouter's detail (now configured) and run the liveness Test.
	await page.getByRole("button", { name: "Open OpenRouter models" }).click();
	await expect(
		page.getByRole("heading", { name: "OpenRouter" }),
	).toBeVisible();

	// Test → Core resolves the ApiKey credential, spawns a one-shot faux Worker
	// with the fixed "ping" prompt; the faux provider emits "pong" (a text token),
	// which the probe collects as alive → the indicator shows "Working".
	await page.getByRole("button", { name: "Test" }).click();
	await expect(page.getByRole("status")).toHaveText(/Working/, {
		timeout: 15_000,
	});

	// No-persistence (ADR-0062): the liveness probe created no Thread/Run/message,
	// so the sidebar thread count is still 0 — the Test left the Workspace untouched.
	expect(await chat.threadCount()).toBe(0);
});
