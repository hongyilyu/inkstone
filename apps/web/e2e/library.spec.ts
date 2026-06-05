import { expect, test } from "@playwright/test";

// Web-only e2e (runs against `pnpm preview`, no Core): the Library is
// mock-driven, so a real browser exercises the whole surface end to end. The
// Core-wired flows (chat streaming, provider connect, models, run errors, tool
// calls) live in the full-system harness under `tests/e2e/`.

// Fail any test on an uncaught page error.
test.beforeEach(({ page }) => {
	page.on("pageerror", (err) => {
		throw new Error(`page error: ${err.message}`);
	});
});

test("opens the Library from the sidebar and shows Today", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: /^library$/i }).click();

	await expect(page).toHaveURL(/\/library$/);
	await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
	// Library nav lists the four kinds with counts.
	const nav = page.getByRole("navigation", { name: /library/i });
	await expect(nav.getByRole("link", { name: /people/i })).toBeVisible();
	await expect(nav.getByRole("link", { name: /recipes/i })).toBeVisible();
});

test("browses People and opens the detail inspector", async ({ page }) => {
	await page.goto("/library/people");

	await expect(
		page.getByRole("heading", { name: "People", level: 1 }),
	).toBeVisible();
	// Open one person; the inspector shows fields and the capture source.
	await page.getByRole("button", { name: /priya nair/i }).click();

	await expect(page).toHaveURL(/\/library\/people\?id=person_priya/);
	const panel = page.getByRole("complementary", {
		name: /priya nair details/i,
	});
	await expect(
		panel.getByRole("heading", { name: "Priya Nair" }),
	).toBeVisible();
	await expect(panel.getByText(/captured from/i)).toBeVisible();
	await expect(panel.getByText(/migration standup notes/i)).toBeVisible();
});

test("filters a collection and teaches an empty result", async ({ page }) => {
	await page.goto("/library/people");
	const search = page.getByRole("textbox", { name: /search people/i });

	await search.fill("marco");
	await expect(page.getByText("Marco Reyes")).toBeVisible();
	await expect(page.getByText("Priya Nair")).toHaveCount(0);

	await search.fill("zzznobody");
	await expect(page.getByText(/no matches/i)).toBeVisible();
});

test("command palette searches and navigates to an entity", async ({
	page,
}) => {
	await page.goto("/library");
	await page.keyboard.press("Meta+k");

	const input = page.getByPlaceholder(/search threads, people, projects/i);
	await expect(input).toBeVisible();
	await input.fill("alice");

	const results = page.getByRole("listbox", { name: /results/i });
	await expect(
		results.getByRole("option", { name: /alice whitman/i }),
	).toBeVisible();

	await input.press("Enter");
	await expect(page).toHaveURL(/\/library\/people\?id=person_alice/);
	await expect(
		page
			.getByRole("complementary", { name: /alice whitman details/i })
			.getByRole("heading", { name: "Alice Whitman" }),
	).toBeVisible();
});

test("toggles a todo done", async ({ page }) => {
	await page.goto("/library/todos");
	const open = page.getByRole("button", {
		name: 'Mark "Book the overdue dental cleaning" done',
	});
	await expect(open).toBeVisible();

	await open.click();

	await expect(
		page.getByRole("button", {
			name: 'Mark "Book the overdue dental cleaning" not done',
		}),
	).toBeVisible();
});

test("toggles the theme", async ({ page }) => {
	await page.goto("/library");
	const before = await page.evaluate(
		() => document.documentElement.dataset.theme ?? "light",
	);

	await page.getByRole("button", { name: /toggle theme/i }).click();

	const after = await page.evaluate(
		() => document.documentElement.dataset.theme,
	);
	expect(after).not.toBe(before);
	expect(["light", "dark"]).toContain(after);
});
