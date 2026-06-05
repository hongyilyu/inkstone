import { expect, test } from "@playwright/test";

// Web-only smoke (runs against `pnpm preview`, no Core). It proves the built SPA
// loads and its three regions render, and that Core-less reads degrade
// gracefully (the sidebar shows its empty-state rather than throwing). The
// Core-wired chat/streaming/thread behaviour is covered by the full-system
// harness in `tests/e2e/`.

test("loads the chat shell and degrades gracefully without Core", async ({
	page,
}) => {
	page.on("pageerror", (err) => {
		throw new Error(`page error: ${err.message}`);
	});

	await page.goto("/");

	// Three-region shell (landmarks).
	const sidebar = page.getByRole("complementary", { name: /sidebar/i });
	const activity = page.getByRole("complementary", { name: /activity/i });
	await expect(sidebar).toBeVisible();
	await expect(page.getByRole("main")).toBeVisible();
	await expect(activity).toBeVisible();

	// Sidebar chrome: New Chat, the Library peer entry, the thread section.
	await expect(
		sidebar.getByRole("button", { name: /new chat/i }),
	).toBeVisible();
	await expect(
		sidebar.getByRole("button", { name: /^library$/i }),
	).toBeVisible();
	await expect(sidebar.getByText(/Last 30 Days/i)).toBeVisible();
	// No Core in preview → the thread/list read resolves empty, not a throw.
	await expect(sidebar.getByText(/no threads match/i)).toBeVisible();

	// Composer.
	await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Send$/i })).toBeVisible();

	// Activity rail filter pills (mock-driven, scoped to the rail).
	await expect(activity.getByRole("button", { name: /^all$/i })).toBeVisible();
	await expect(
		activity.getByRole("button", { name: /^edits$/i }),
	).toBeVisible();
	await expect(
		activity.getByRole("button", { name: /^automations$/i }),
	).toBeVisible();

	// Top-right controls.
	await expect(
		page.getByRole("button", { name: /toggle theme/i }),
	).toBeVisible();

	// The t3 palette is wired: body paints with --sidebar (either theme's hex).
	const bg = await page.evaluate(
		() => getComputedStyle(document.body).backgroundColor,
	);
	expect(bg).toMatch(/^rgb\((234, 208, 239|19, 19, 20)\)$/);
});
