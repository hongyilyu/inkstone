import { expect, test } from "./fixtures.js";

/**
 * Models settings acceptance flow (ADR-0024): a user opens Settings → Models,
 * picks a preferred model and a global effort, and both survive a full page
 * reload — proving the choice round-trips through Core's `settings/*` + tier-2
 * SQLite (not just client state). Runs against the default Core (real
 * `openai-codex` catalog over `model/catalog`); no provider connection needed.
 */
test("Models settings: preferred model + effort persist across reload", async ({
	chat,
	page,
}) => {
	await chat.goto();

	// Gear navigates to the /settings/models route.
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

	// The catalog table renders the openai-codex models.
	const row = page.getByRole("row", { name: /GPT-5\.5/ });
	await expect(row).toBeVisible();

	// Initially no model is preferred; pick GPT-5.5.
	await row.hover();
	await row.getByRole("button", { name: /set as preferred/i }).click();
	await expect(row.getByText(/^preferred$/i)).toBeVisible();

	// Set the global effort to High.
	await page.getByRole("radio", { name: "High" }).click();
	await expect(page.getByRole("radio", { name: "High" })).toHaveAttribute(
		"aria-checked",
		"true",
	);

	// Reload: the SPA boots fresh at /settings/models and re-reads settings
	// from Core. Both choices must still be reflected.
	await page.reload();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

	await expect(
		page.getByRole("row", { name: /GPT-5\.5/ }).getByText(/^preferred$/i),
	).toBeVisible();
	await expect(page.getByRole("radio", { name: "High" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
});
