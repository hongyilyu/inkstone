import { expect, test } from "./fixtures.js";

/**
 * Models settings acceptance flow (ADR-0024): before any pick, `settings/get`
 * falls back to the per-provider default (GPT-5.5), so it shows Preferred from
 * the start — mirroring how effort defaults to "off". A user then picks a
 * *different* model and a global effort, and both survive a full page reload —
 * proving the explicit choice overrides the default and round-trips through
 * Core's `settings/*` + tier-2 SQLite (not just client state). Runs against the
 * default Core (real `openai-codex` catalog over `model/catalog`); no provider
 * connection needed.
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
	await expect(
		page.getByRole("row", { name: /GPT-5\.5/ }).getByText(/^preferred$/i),
	).toBeVisible();

	// Pick a *different* model to prove an explicit choice overrides the default.
	const mini = page.getByRole("row", { name: /GPT-5\.4 Mini/ });
	await mini.hover();
	await mini.getByRole("button", { name: /set as preferred/i }).click();
	await expect(mini.getByText(/^preferred$/i)).toBeVisible();

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
		page.getByRole("row", { name: /GPT-5\.4 Mini/ }).getByText(/^preferred$/i),
	).toBeVisible();
	await expect(page.getByRole("radio", { name: "High" })).toHaveAttribute(
		"aria-checked",
		"true",
	);
});
