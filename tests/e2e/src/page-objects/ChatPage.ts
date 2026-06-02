import { expect, type Page } from "@playwright/test";

/**
 * Page object over the rendered chat surface (ADR-0019: tests assert through
 * the same DOM a user touches; selectors live here, not in specs). Methods are
 * behavior-level — `send`, `waitForAssistantText`, `newChat`, `openThread` —
 * so the specs read as user flows.
 */
export class ChatPage {
	constructor(
		private readonly page: Page,
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
		await this.sidebar().getByRole("button", { name: title }).click();
	}

	/** Number of thread rows currently listed in the sidebar. */
	async threadCount(): Promise<number> {
		// Thread rows are buttons inside the sidebar's scrolling list; the
		// New Chat / toggle / account buttons are excluded by being outside <ul>.
		return this.sidebar().locator("ul button").count();
	}

	/** Reload the page (simulates the user refreshing mid-stream). */
	async reload(): Promise<void> {
		await this.page.reload();
		await expect(this.composer()).toBeVisible();
	}
}
