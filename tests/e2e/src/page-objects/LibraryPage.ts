import type { Locator, Page } from "@playwright/test";

/** Page object over the Library topic surfaces and rail editors (ADR-0019): selectors live here so specs read as user flows. */
export class LibraryPage {
	constructor(
		readonly page: Page,
		private readonly baseUrl: string,
	) {}

	/** Navigate to an Entity-Type collection route by its collection slug (e.g. `todos`, `people`, `media`), optionally selecting an entity via `?id=`. */
	async gotoCollection(collection: string, id?: string): Promise<void> {
		const path = id
			? `/library/${collection}?id=${id}`
			: `/library/${collection}`;
		await this.page.goto(new URL(path, this.baseUrl).href);
	}

	/** Click the "New <kind>" affordance to open the create rail (e.g. `newEntity("todo")`). */
	async newEntity(kind: string): Promise<void> {
		await this.page
			.getByRole("button", { name: new RegExp(`new ${kind}`, "i") })
			.click();
	}

	/** The detail/editor rail landmark by its accessible name (e.g. `/new todo/i`, `/Dune details/i`). */
	rail(name: string | RegExp) {
		return this.page.getByRole("complementary", { name });
	}

	/** A labeled editor field inside `rail` (Title, Note, Body, …). */
	field(rail: Locator, label: string) {
		return rail.getByLabel(label);
	}

	/** Fill the labeled text field inside `rail` with `value`. */
	async fillField(rail: Locator, label: string, value: string): Promise<void> {
		await this.field(rail, label).fill(value);
	}

	/** Choose `option` in the labeled select inside `rail` (Medium, State, Status). */
	async selectField(
		rail: Locator,
		label: string,
		option: string,
	): Promise<void> {
		await this.field(rail, label).selectOption(option);
	}

	/** Click the editor's Save button inside `rail`. */
	async save(rail: Locator): Promise<void> {
		await rail.getByRole("button", { name: /^save$/i }).click();
	}

	/** Click "Edit <kind>" inside `rail` to switch the detail view into the editor. */
	async enterEdit(rail: Locator, kind: string): Promise<void> {
		await rail
			.getByRole("button", { name: new RegExp(`edit ${kind}`, "i") })
			.click();
	}

	/** The "Delete <kind>" affordance inside `rail` — the FIRST step of the inline two-step confirm. */
	deleteButton(rail: Locator, kind: string) {
		return rail.getByRole("button", {
			name: new RegExp(`delete ${kind}`, "i"),
		});
	}

	/** The inline confirm prompt ("Delete this <kind>?") shown between the two delete steps. */
	deleteConfirmPrompt(rail: Locator, kind: string) {
		return rail.getByText(new RegExp(`delete this ${kind}\\?`, "i"));
	}

	/** Run the full inline two-step delete confirm inside `rail` (ADR-0033, "approval is sacred"). */
	async deleteEntity(rail: Locator, kind: string): Promise<void> {
		await this.deleteButton(rail, kind).click();
		await rail.getByRole("button", { name: /^delete$/i }).click();
	}

	/** Back out of the revealed inline delete confirm inside `rail` — no write is sent. */
	async cancelDelete(rail: Locator): Promise<void> {
		await rail.getByRole("button", { name: /cancel/i }).click();
	}

	/** The live collection region for a topic by its accessible name (e.g. `/todos/i`). */
	collection(name: string | RegExp) {
		return this.page.getByRole("region", { name });
	}

	/** The root-mounted EntityCue success toast: the one `role="status"` carrying
	 * `data-cue-key`; scoping on that attribute avoids the app's other live
	 * regions (CopyOutcome, the composer's run status). It auto-dismisses at
	 * CUE_DISMISS_MS (2500ms), so assert appearance promptly and don't assert
	 * disappearance. */
	successCue() {
		return this.page.locator('[role="status"][data-cue-key]');
	}
}
