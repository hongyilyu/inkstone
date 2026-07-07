import { expect, test } from "./fixtures.js";
import { SettingsPage } from "./page-objects/SettingsPage.js";

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
	const settings = new SettingsPage(page);
	await chat.goto();

	// Gear navigates to the /settings/models route.
	await settings.open();
	await expect(settings.modelsHeading()).toBeVisible();

	// LIST view: the OpenAI provider entry + the global effort control. Set the
	// effort to High (the default is "off") to prove an explicit choice persists.
	await settings.effortRadio("High").click();
	await expect(settings.effortRadio("High")).toHaveAttribute(
		"aria-checked",
		"true",
	);

	// Drill into the OpenAI provider's detail. The curated catalog ships a single
	// chat model (GPT-5.5), already Preferred — Core's `settings/get` falls back
	// to it. With one model there is nothing else to switch to; effort carries the
	// explicit-choice round-trip below.
	await settings.openProvider(/OpenAI/).click();
	await expect(
		settings.modelRow(/GPT-5\.5/).getByText(/^preferred$/i),
	).toBeVisible();

	// Reload: the SPA boots fresh at /settings/models and re-reads settings from
	// Core. The page reopens on the LIST view; the effort choice must round-trip.
	await page.reload();
	await expect(settings.modelsHeading()).toBeVisible();
	await expect(settings.effortRadio("High")).toHaveAttribute(
		"aria-checked",
		"true",
	);

	// Drill back into the provider detail and confirm the default model survived.
	await settings.openProvider(/OpenAI/).click();
	await expect(
		settings.modelRow(/GPT-5\.5/).getByText(/^preferred$/i),
	).toBeVisible();
});

/**
 * The per-provider detail lets the user toggle which models are enabled for chat,
 * with the current default's toggle LOCKED so the default can never fall outside
 * the enabled set (mirrors Core's default∈enabled invariant). The pi-ai 0.80.2
 * (#292) openai-codex chat catalog ships a single selectable model (GPT-5.5),
 * which is the default — so the provable end-to-end behavior is that the sole
 * model is Preferred, enabled, and its disable toggle is locked. The
 * disable-a-model → drops-from-composer-picker loop (slice 3 ↔ slice 5) needs a
 * second selectable model and is exercised once a second model/provider lands;
 * the scoping logic itself is covered by ModelPicker.test.tsx + models.page.test.tsx.
 */
test("Models settings: the default model is enabled with a locked disable toggle", async ({
	chat,
	page,
}) => {
	const settings = new SettingsPage(page);
	await chat.goto();

	await settings.open();
	await expect(settings.modelsHeading()).toBeVisible();

	// Drill into the OpenAI provider's detail.
	await settings.openProvider(/OpenAI/).click();

	// The default (GPT-5.5) is Preferred and its enable toggle is LOCKED — a
	// checked, disabled checkbox the user can't un-toggle (mirrors Core's
	// default∈enabled invariant).
	const defaultRow = settings.modelRow(/GPT-5\.5/);
	await expect(defaultRow.getByText(/^preferred$/i)).toBeVisible();
	const defaultToggle = settings.enabledCheckbox(defaultRow);
	await expect(defaultToggle).toBeChecked();
	await expect(defaultToggle).toBeDisabled();
});
