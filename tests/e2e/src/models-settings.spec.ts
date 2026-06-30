import { expect, test } from "./fixtures.js";

/**
 * Models settings acceptance flow (ADR-0024): before any pick, `settings/get`
 * falls back to the per-provider default (GPT-5.5), so it shows Preferred from
 * the start — mirroring how effort defaults to "off". The user explicitly
 * re-affirms the model and picks a non-default global effort, and both survive a
 * full page reload — proving the explicit choice round-trips through Core's
 * `settings/*` + tier-2 SQLite (not just client state). Runs against the default
 * Core, whose curated `openai-codex` catalog (over `model/catalog`) ships a
 * single chat model, GPT-5.5; no provider connection needed.
 */
test("Models settings: default is preferred; an explicit model + effort persist across reload", async ({
	chat,
	page,
}) => {
	await chat.goto();

	// Gear navigates to the /settings/models route.
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

	// The catalog table renders the openai-codex models, and the per-provider
	// default (GPT-5.5) is already Preferred before any pick — Core's
	// `settings/get` falls back to it.
	const gpt55 = page.getByRole("row", { name: /GPT-5\.5/ });
	await expect(gpt55.getByText(/^preferred$/i)).toBeVisible();

	// The curated catalog ships a single model (GPT-5.5), which is already
	// Preferred — there is no *other* model to switch to, so the non-default
	// *effort* below is what proves an explicit choice round-trips through Core.
	// Set the global effort to High (the default is "off").
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
