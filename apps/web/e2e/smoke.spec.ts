import { test, expect } from "@playwright/test";

test("loads the chat surface with all eight slice regions populated", async ({ page }) => {
	page.on("pageerror", (err) => {
		throw new Error(`Console error: ${err.message}`);
	});

	await page.goto("/");

	// Slice 1: 3-region shell (landmarks)
	const sidebar = page.getByRole("complementary", { name: /sidebar/i });
	const activity = page.getByRole("complementary", { name: /activity/i });
	await expect(sidebar).toBeVisible();
	await expect(page.getByRole("main")).toBeVisible();
	await expect(activity).toBeVisible();

	// Slice 13: Sidebar t3 layout — New Chat pill, Last 30 Days section, first thread
	await expect(sidebar.getByRole("button", { name: /new chat/i })).toBeVisible();
	await expect(sidebar.getByText(/Last 30 Days/i)).toBeVisible();
	await expect(sidebar.getByText(/Turn standup action items/i)).toBeVisible();

	// Slice 3: Chat bubbles + an action chip from the agent turn
	// (assertion uses concrete mock content; updates if mock.ts changes.)
	await expect(page.getByText(/Morning\. What did standup land on/i)).toBeVisible();
	await expect(page.getByText(/standup-2026-05-21\.md/i).first()).toBeVisible(); // an action chip label on the agent turn

	// Slice 4: Compose footer
	await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Send$/i })).toBeVisible();
	await expect(page.getByText(/gemma-3 27b/i).first()).toBeVisible();
	await expect(page.getByText(/4,812/).first()).toBeVisible();

	// Slice 5: Proposal cards inline (also surfaced in ActivityRail)
	await expect(page.getByText(/Backfill \/v2\/contacts before cutover/i).first()).toBeVisible();

	// Slice 6: Activity rail filter pill (scoped to ActivityRail — "automations" pill collides with Sidebar Automations button)
	await expect(activity.getByRole("button", { name: /^all$/i })).toBeVisible();
	await expect(activity.getByRole("button", { name: /^edits$/i })).toBeVisible();
	await expect(activity.getByRole("button", { name: /^automations$/i })).toBeVisible();

	// Slice 7: Queue banner — first item visible (banner can render twice if mounted in App + ChatColumn etc.; assert at least one)
	await expect(page.getByText(/Inbox sweeper · pick aggressiveness/i).first()).toBeVisible();

	// Slice 8: Top-right controls + welcome banner
	await expect(page.getByRole("button", { name: /toggle theme/i })).toBeVisible();

	// Slice 13: t3 palette wired — body bg should resolve to either theme's --background hex.
	const bg = await page.evaluate(() =>
		getComputedStyle(document.body).backgroundColor,
	);
	expect(bg).toMatch(/^rgb\((242, 225, 244|33, 20, 30)\)$/);
});
