import type { Locator, Page } from "@playwright/test";

/** Page object over Settings → Models — the provider master/detail (ADR-0024) reached via the gear from a chat surface (ADR-0019): selectors live here so specs read as user flows. */
export class SettingsPage {
	constructor(readonly page: Page) {}

	/** Click the gear (the "Settings" button) to navigate to the /settings/models route. */
	async open(): Promise<void> {
		await this.page.getByRole("button", { name: "Settings" }).click();
	}

	/** The "Models" page heading — visible once the LIST view has rendered. */
	modelsHeading() {
		return this.page.getByRole("heading", { name: "Models" });
	}

	/** The global effort radio by its label (e.g. "High"). */
	effortRadio(label: string) {
		return this.page.getByRole("radio", { name: label });
	}

	/** The drill-in control for a provider's DETAIL view (e.g. `/OpenAI/`). */
	openProvider(label: string | RegExp) {
		return this.page.getByRole("button", { name: label });
	}

	/** A model row in the provider DETAIL view by its accessible name (e.g. `/GPT-5\.5/`). */
	modelRow(name: string | RegExp) {
		return this.page.getByRole("row", { name });
	}

	/** The "enabled for chat" toggle inside a model `row` (locked when the row is the current default). */
	enabledCheckbox(row: Locator) {
		return row.getByRole("checkbox", { name: /enabled for chat/i });
	}

	/**
	 * The Settings → Models row `<div>` for a provider, scoped off its drill-in
	 * button (`Open <label> models`). With more than one provider row on the page,
	 * assertions on `provider-status` must be row-scoped; this centralizes that
	 * locator so each spec (and each future provider row) doesn't re-derive the
	 * `button → xpath=.. → getByTestId("provider-status")` chain.
	 */
	providerRow(providerLabel: string): Locator {
		return this.page
			.getByRole("button", { name: `Open ${providerLabel} models` })
			.locator("xpath=..");
	}
}
