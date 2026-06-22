import { expect, type Page } from "@playwright/test";

/** Page object over the rendered chat surface (ADR-0019): selectors live here so specs read as user flows. */
export class ChatPage {
	constructor(
		readonly page: Page,
		private readonly baseUrl: string,
	) {}

	/** Navigate to the served SPA and wait for the composer to be ready. */
	async goto(): Promise<void> {
		await this.page.goto(this.baseUrl);
		await expect(this.composer()).toBeVisible();
	}

	/** Navigate directly to a SPA path (e.g. a deep link `/thread/<id>`), no composer wait. */
	async gotoPath(path: string): Promise<void> {
		await this.page.goto(new URL(path, this.baseUrl).href);
	}

	/** The message composer textarea. */
	composer() {
		return this.page.getByRole("textbox", { name: /message/i });
	}

	/** Type `text` into the composer and submit it (Enter sends). */
	async send(text: string): Promise<void> {
		const box = this.composer();
		await box.click();
		await box.fill(text);
		await this.page.getByRole("button", { name: /^send$/i }).click();
	}

	/** Click the composer's Stop control to cancel the active Run (ADR-0014). */
	async stop(): Promise<void> {
		await this.page.getByRole("button", { name: /^stop$/i }).click();
	}

	/** The settled assistant FAILURE bubble (genuine worker/provider error). */
	assistantError() {
		return this.page.getByTestId("assistant-error");
	}

	/** The settled assistant STOPPED bubble — a deliberate user cancel (calm, not
	 * the destructive failure alert; ADR-0014 cancel-is-not-an-error). */
	assistantStopped() {
		return this.page.getByTestId("assistant-stopped");
	}

	/** The sidebar landmark. */
	sidebar() {
		return this.page.getByRole("complementary", { name: /sidebar/i });
	}

	/** Assistant message bubbles (in DOM order). */
	assistantBubbles() {
		return this.page.locator('[data-role="assistant"]');
	}

	/** User message bubbles (in DOM order). */
	userBubbles() {
		return this.page.locator('[data-role="user"]');
	}

	/** A single user bubble whose text contains `text` (the `<li>`, so `data-message-id` lives here). */
	userBubble(text: string | RegExp) {
		return this.userBubbles().filter({ hasText: text });
	}

	/** Completed assistant turns expose a Copy control; its count is a monotonic "turns finished" signal for sequencing multi-send flows. */
	copyButtons() {
		return this.page.getByRole("button", { name: /copy$/i });
	}

	/** The element currently wearing the search-jump lamplight ring (issue #138), if any. */
	searchJumpHighlight() {
		return this.page.locator("[data-highlighted]");
	}

	/** The interactive proposal review card (slice 9). */
	proposalCard() {
		return this.page.locator("[data-proposal]");
	}

	/** Wait until some assistant bubble contains `expected` (substring/regex). */
	async waitForAssistantText(expected: string | RegExp): Promise<void> {
		await expect(
			this.assistantBubbles().filter({ hasText: expected }),
		).toHaveCount(1, { timeout: 15_000 });
	}

	/** Assert no assistant bubble yet contains `text` (e.g. the gated tail). */
	async expectNoAssistantText(text: string): Promise<void> {
		await expect(this.assistantBubbles().filter({ hasText: text })).toHaveCount(
			0,
		);
	}

	/** Click "New Chat" to clear focus so the next send mints a fresh thread. */
	async newChat(): Promise<void> {
		await this.sidebar()
			.getByRole("button", { name: /new chat/i })
			.click();
	}

	/** Open the thread whose sidebar row title matches `title`. */
	async openThread(title: string | RegExp): Promise<void> {
		// First button is the row selector; avoids strict-mode ambiguity with the copy-id button.
		await this.sidebar()
			.locator("ul li")
			.filter({ hasText: title })
			.getByRole("button")
			.first()
			.click();
	}

	/** Click the copy-id button for the row titled `title`. */
	async copyThreadId(title: string): Promise<void> {
		await this.sidebar()
			.getByRole("button", { name: `Copy thread id for ${title}` })
			.click();
	}

	/** Read the browser clipboard (requires clipboard permission granted). */
	async clipboardText(): Promise<string> {
		return this.page.evaluate(() => navigator.clipboard.readText());
	}

	/** Number of thread rows currently listed in the sidebar. */
	async threadCount(): Promise<number> {
		// One copy-id button per real thread row (empty-state <li> has none), so this counts threads without double-counting.
		return this.sidebar()
			.locator('ul button[aria-label^="Copy thread id"]')
			.count();
	}

	/** Reload the page (simulates the user refreshing mid-stream). */
	async reload(): Promise<void> {
		await this.page.reload();
		await expect(this.composer()).toBeVisible();
	}

	/** The current URL path (without origin) — the focused Thread lives here (ADR-0042). */
	pathname(): string {
		return new URL(this.page.url()).pathname;
	}

	/** The current URL's raw query string (e.g. `?focusedMessageId=…`), without the leading `?`. */
	search(): string {
		return new URL(this.page.url()).search.replace(/^\?/, "");
	}

	/** The ⌘K command palette dialog. */
	commandPalette() {
		return this.page.getByRole("dialog", { name: "Search" });
	}

	/** Open the palette via ⌘K / Ctrl+K and wait for its search box (the handler accepts metaKey OR ctrlKey, so Meta+k works on every platform). */
	async openCommandPalette(): Promise<void> {
		await this.page.keyboard.press("Meta+k");
		await expect(this.commandPalette().getByRole("combobox")).toBeVisible();
	}

	/** Type `query` into the open palette's search box. */
	async searchCommandPalette(query: string): Promise<void> {
		await this.commandPalette().getByRole("combobox").fill(query);
	}

	/** The result-option buttons under the palette group labelled `label` (e.g. "Messages"). */
	commandPaletteGroupOptions(label: string) {
		// Each group renders as a wrapper <div> with a label child then its option
		// buttons. Anchor on the label element, step to its wrapper parent, and
		// scope options there so a hit is attributable to its group (Messages vs
		// Threads vs a Library kind) — not just "some option somewhere".
		return this.commandPalette()
			.getByText(label, { exact: true })
			.locator("xpath=..")
			.getByRole("option");
	}
}
