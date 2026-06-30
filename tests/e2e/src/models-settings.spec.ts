import { expect, test } from "./fixtures.js";

/**
 * Models settings acceptance flow (ADR-0024): Settings → Models is a provider
 * master/detail. The LIST view shows a provider row (OpenAI) and the global
 * effort control; drilling in opens that provider's DETAIL view. Before any
 * pick, `settings/get` falls back to the per-provider default (GPT-5.5), so it
 * shows Preferred from the start — mirroring how effort defaults to "off". The
 * curated `openai-codex` chat catalog (over `model/catalog`) ships a single
 * model, GPT-5.5, which is already Preferred — there is no *other* model to
 * switch to, so the non-default *effort* is what proves an explicit choice
 * round-trips through Core's `settings/*` + tier-2 SQLite (not just client
 * state). Runs against the default Core; no provider connection needed.
 */
test("Models settings: drill into a provider; effort persists and the default model survives reload", async ({
	chat,
	page,
}) => {
	await chat.goto();

	// Gear navigates to the /settings/models route.
	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

	// LIST view: the OpenAI provider entry + the global effort control. Set the
	// effort to High (the default is "off") to prove an explicit choice persists.
	await page.getByRole("radio", { name: "High" }).click();
	await expect(page.getByRole("radio", { name: "High" })).toHaveAttribute(
		"aria-checked",
		"true",
	);

	// Drill into the OpenAI provider's detail. The curated catalog ships a single
	// chat model (GPT-5.5), already Preferred — Core's `settings/get` falls back
	// to it. With one model there is nothing else to switch to; effort carries the
	// explicit-choice round-trip below.
	await page.getByRole("button", { name: /OpenAI/ }).click();
	await expect(
		page.getByRole("row", { name: /GPT-5\.5/ }).getByText(/^preferred$/i),
	).toBeVisible();

	// Reload: the SPA boots fresh at /settings/models and re-reads settings from
	// Core. The page reopens on the LIST view; the effort choice must round-trip.
	await page.reload();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
	await expect(page.getByRole("radio", { name: "High" })).toHaveAttribute(
		"aria-checked",
		"true",
	);

	// Drill back into the provider detail and confirm the default model survived.
	await page.getByRole("button", { name: /OpenAI/ }).click();
	await expect(
		page.getByRole("row", { name: /GPT-5\.5/ }).getByText(/^preferred$/i),
	).toBeVisible();
});

/**
 * Closes the loop with slice 3: the per-provider detail lets the user toggle which
 * models are enabled for chat. Disabling a non-default model persists through
 * Core's `settings/set { enabled_models }` (round-trips across a reload) AND scopes
 * the composer's ModelPicker (the slice-3 consumer) so the disabled model vanishes
 * there. The current default (GPT-5.5) cannot be disabled — its toggle is locked.
 */
test("Models settings: disable a non-default model — it persists, drops from the composer picker, and the default's toggle is locked", async ({
	chat,
	page,
}) => {
	await chat.goto();

	await page.getByRole("button", { name: "Settings" }).click();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();

	// Drill into the OpenAI provider's detail.
	await page.getByRole("button", { name: /OpenAI/ }).click();

	// The default (GPT-5.5) is Preferred and its enable toggle is LOCKED — a
	// disabled checkbox the user can't un-toggle (mirrors Core's default∈enabled).
	const defaultRow = page.getByRole("row", { name: /GPT-5\.5/ });
	await expect(defaultRow.getByText(/^preferred$/i)).toBeVisible();
	const defaultToggle = defaultRow.getByRole("checkbox", {
		name: /enabled for chat/i,
	});
	await expect(defaultToggle).toBeChecked();
	await expect(defaultToggle).toBeDisabled();

	// Disable a non-default model (GPT-5.4 Mini). It starts enabled (empty set =
	// "all enabled"); toggling it OFF materializes the full catalog minus it.
	const miniRow = page.getByRole("row", { name: /GPT-5\.4 Mini/ });
	const miniToggle = miniRow.getByRole("checkbox", {
		name: /enabled for chat/i,
	});
	await expect(miniToggle).toBeChecked();
	await miniToggle.click();
	await expect(miniToggle).not.toBeChecked();

	// Reload: the explicit enabled set must round-trip through Core's SQLite.
	await page.reload();
	await expect(page.getByRole("heading", { name: "Models" })).toBeVisible();
	await page.getByRole("button", { name: /OpenAI/ }).click();
	await expect(
		page
			.getByRole("row", { name: /GPT-5\.4 Mini/ })
			.getByRole("checkbox", { name: /enabled for chat/i }),
	).not.toBeChecked();

	// Back to chat: the composer ModelPicker (slice-3 consumer) now lists only the
	// enabled models — GPT-5.4 Mini is gone, the default GPT-5.5 remains.
	await chat.goto();
	await page.getByRole("button", { name: /select model/i }).click();
	const pickerList = page.getByRole("list");
	await expect(pickerList.getByText("GPT-5.5", { exact: true })).toBeVisible();
	await expect(
		pickerList.getByText("GPT-5.4 Mini", { exact: true }),
	).toHaveCount(0);
});
