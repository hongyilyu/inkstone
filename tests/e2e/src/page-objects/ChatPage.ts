import { expect, type Page } from "@playwright/test";

/**
 * Page object over the rendered chat surface (ADR-0019: tests assert through
 * the same DOM a user touches; selectors live here, not in specs). Methods are
 * behavior-level — `send`, `waitForAssistantText`, `newChat`, `openThread` —
 * so the specs read as user flows.
 */
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
		await expect(
			this.assistantBubbles().filter({ hasText: text }),
		).toHaveCount(0);
	}

	/** Click "New Chat" to clear focus so the next send mints a fresh thread. */
	async newChat(): Promise<void> {
		await this.sidebar().getByRole("button", { name: /new chat/i }).click();
	}

	/** Open the thread whose sidebar row title matches `title`. */
	async openThread(title: string | RegExp): Promise<void> {
		// Each row has a select button (named by title) AND a copy-id button
		// (named "Copy thread id for …"). Scope to the row's first button (the
		// selector) so the copy button never causes a strict-mode ambiguity.
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
		// One copy-id button per real thread row (the empty-state <li> has none),
		// so this counts threads without double-counting the per-row buttons.
		return this.sidebar()
			.locator('ul button[aria-label^="Copy thread id"]')
			.count();
	}

	/** Reload the page (simulates the user refreshing mid-stream). */
	async reload(): Promise<void> {
		await this.page.reload();
		await expect(this.composer()).toBeVisible();
	}
}
