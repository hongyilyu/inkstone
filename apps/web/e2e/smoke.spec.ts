import { expect, test } from "@playwright/test";

// Web-only smoke (runs against `pnpm preview`, no Core); Core-wired behaviour is covered by the full-system harness in `tests/e2e/`.

test("loads the chat shell and degrades gracefully without Core", async ({
	page,
}) => {
	page.on("pageerror", (err) => {
		throw new Error(`page error: ${err.message}`);
	});

	await page.goto("/");

	const sidebar = page.getByRole("complementary", { name: /sidebar/i });
	const activity = page.getByRole("complementary", { name: /activity/i });
	await expect(sidebar).toBeVisible();
	await expect(page.getByRole("main")).toBeVisible();
	await expect(activity).toBeVisible();

	await expect(
		sidebar.getByRole("button", { name: /new chat/i }),
	).toBeVisible();
	await expect(
		sidebar.getByRole("button", { name: /^library$/i }),
	).toBeVisible();
	// No Core in preview → thread/list resolves empty (not a throw) → empty-state copy.
	await expect(sidebar.getByText(/no threads yet/i)).toBeVisible();

	await expect(page.getByRole("textbox", { name: /message/i })).toBeVisible();
	await expect(page.getByRole("button", { name: /^Send$/i })).toBeVisible();

	await expect(activity.getByRole("button", { name: /^all$/i })).toBeVisible();
	await expect(
		activity.getByRole("button", { name: /^edits$/i }),
	).toBeVisible();
	await expect(
		activity.getByRole("button", { name: /^automations$/i }),
	).toBeVisible();

	await expect(
		page.getByRole("button", { name: /toggle theme/i }),
	).toBeVisible();

	// Body paints with --sidebar (either theme's hex), proving the t3 palette is wired.
	const bg = await page.evaluate(
		() => getComputedStyle(document.body).backgroundColor,
	);
	expect(bg).toMatch(/^rgb\((234, 208, 239|19, 19, 20)\)$/);
});
