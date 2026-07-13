import { expect, type Page } from "@playwright/test";

/** Page object over the global ⌘K Command Palette (mounted in `__root`, ADR-0024): selectors live here so specs read as user flows. */
export class CommandPalette {
	constructor(readonly page: Page) {}

	/** The palette dialog popup (base-ui `Dialog.Popup`, labelled "Search"). */
	dialog() {
		return this.page.getByRole("dialog", { name: /search/i });
	}

	/** The search combobox input inside the palette. */
	input() {
		return this.page.getByRole("combobox");
	}

	/** Open the palette via the ⌘K / Ctrl+K shortcut and wait for it to render. */
	async openWithKeyboard(): Promise<void> {
		await this.page.keyboard.press("ControlOrMeta+k");
		await expect(this.dialog()).toBeVisible();
	}

	/** Close the palette with Escape and wait for it to detach. */
	async close(): Promise<void> {
		await this.page.keyboard.press("Escape");
		await expect(this.dialog()).toBeHidden();
	}

	/** Type `query` into the (already-open) palette's combobox. */
	async search(query: string): Promise<void> {
		await this.input().fill(query);
	}

	/** All result options currently listed, in DOM order. */
	options() {
		return this.page.getByRole("option");
	}

	/** A single result option by its visible label (substring/regex). */
	option(name: string | RegExp) {
		return this.page.getByRole("option", { name });
	}

	/** The result-option buttons under the palette group labelled `label` (e.g. "Messages"). */
	groupOptions(label: string) {
		// Each group renders as a wrapper <div> with a label child then its option
		// buttons. Anchor on the label element, step to its wrapper parent, and
		// scope options there so a hit is attributable to its group (Messages vs
		// Threads vs a Library kind) — not just "some option somewhere".
		return this.dialog()
			.getByText(label, { exact: true })
			.locator("xpath=..")
			.getByRole("option");
	}
}
