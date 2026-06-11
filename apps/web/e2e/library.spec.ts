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
	// The Library renders through the shared WorkspaceShell, so it carries the
	// same framed middle region (a single `main` landmark) as the chat surface.
	await expect(page.getByRole("main")).toBeVisible();
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

test("command palette searches and navigates to a Library item", async ({
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

test("opens a Library item in the shared collapsible rail, then closes it", async ({
	page,
}) => {
	// Recipes stay mock-backed, so they render without Core (unlike People/Todos).
	await page.goto("/library/recipes");
	await page.getByRole("button", { name: /weeknight ragù/i }).click();
	await expect(page).toHaveURL(/\/library\/recipes\?id=recipe_ragu/);

	// The detail opens in the shared right rail — a complementary landmark, the
	// same region kind the chat surface's rail uses.
	const panel = page.getByRole("complementary", {
		name: /weeknight ragù details/i,
	});
	await expect(
		panel.getByRole("heading", { name: /weeknight ragù/i }),
	).toBeVisible();

	// The shared collapse control (the bay toggle) hides the rail: aria-pressed
	// flips. We assert the semantic state, not pixels. There is no separate close
	// button on the inspector — the rail's collapse control is the only dismiss.
	const toggle = page.getByRole("button", { name: /details panel/i });
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");

	// Model A: collapsing hides the panel but keeps the selection — the `?id`
	// stays in the URL, the row stays current, and the bay/toggle remain so it
	// can be reopened. (The bay only disappears when nothing is selected.)
	await expect(page).toHaveURL(/\/library\/recipes\?id=recipe_ragu/);
	await expect(
		page.getByRole("button", { name: /weeknight ragù/i }),
	).toHaveAttribute("aria-current", "true");
	await expect(toggle).toBeVisible();

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("hides the bay toggle when nothing is selected, keeping the card frame inset", async ({
	page,
}) => {
	await page.goto("/library");
	await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

	// Nothing selected → no rail content → no carved bay → no collapse toggle.
	await expect(
		page.getByRole("button", { name: /details panel/i }),
	).toHaveCount(0);

	// The framed card still floats against the pink chrome: its right edge sits a
	// gutter's width inside the viewport, never flush — so the frame/border stays
	// fully visible even with no rail. (jsdom has no CSS, so this lives in e2e.)
	const box = await page.getByTestId("workspace-card").boundingBox();
	const viewport = page.viewportSize();
	expect(box).not.toBeNull();
	expect(viewport).not.toBeNull();
	if (box && viewport) {
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 6);
	}
});

test("reveals the bay toggle only after a collection row is selected", async ({
	page,
}) => {
	// Recipes stay mock-backed, so this runs without Core.
	await page.goto("/library/recipes");
	await expect(
		page.getByRole("heading", { name: "Recipes", level: 1 }),
	).toBeVisible();

	// Nothing selected yet → plain framed card, no bay toggle.
	const toggle = page.getByRole("button", { name: /details panel/i });
	await expect(toggle).toHaveCount(0);

	// Selecting a row reveals the bay toggle and opens the detail panel.
	await page.getByRole("button", { name: /weeknight ragù/i }).click();
	await expect(toggle).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: /weeknight ragù details/i }),
	).toBeVisible();
});

test("drops the bay when navigating away deselects", async ({ page }) => {
	await page.goto("/library/recipes?id=recipe_ragu");
	const toggle = page.getByRole("button", { name: /details panel/i });
	await expect(toggle).toBeVisible();

	// Navigating to another collection clears `?id` (the nav links carry no
	// selection) → nothing selected → the bay + toggle disappear again.
	await page
		.getByRole("navigation", { name: /library/i })
		.getByRole("link", { name: /projects/i })
		.click();
	await expect(page).toHaveURL(/\/library\/projects$/);
	await expect(toggle).toHaveCount(0);

	const box = await page.getByTestId("workspace-card").boundingBox();
	const viewport = page.viewportSize();
	expect(box).not.toBeNull();
	expect(viewport).not.toBeNull();
	if (box && viewport) {
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 6);
	}
});

test("shows the bay toggle for a deep-linked selection on load", async ({
	page,
}) => {
	await page.goto("/library/recipes?id=recipe_ragu");

	await expect(
		page.getByRole("button", { name: /details panel/i }),
	).toBeVisible();
	await expect(
		page
			.getByRole("complementary", { name: /weeknight ragù details/i })
			.getByRole("heading", { name: /weeknight ragù/i }),
	).toBeVisible();
});

test("keeps the framed card border in dark theme with nothing selected", async ({
	page,
}) => {
	await page.goto("/library");
	await page.getByRole("button", { name: /toggle theme/i }).click();
	await expect
		.poll(() => page.evaluate(() => document.documentElement.dataset.theme))
		.toBe("dark");

	// Still no bay toggle, and the card frame still floats inside the viewport.
	await expect(
		page.getByRole("button", { name: /details panel/i }),
	).toHaveCount(0);
	const box = await page.getByTestId("workspace-card").boundingBox();
	const viewport = page.viewportSize();
	expect(box).not.toBeNull();
	expect(viewport).not.toBeNull();
	if (box && viewport) {
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 6);
	}
});

test("keeps the activity-rail toggle on the chat surface (regression)", async ({
	page,
}) => {
	// The homepage rail is always present, so its bay + toggle always show —
	// independent of Core (the rail mounts regardless of data).
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: /activity rail/i }),
	).toBeVisible();
});

test("opens a Today entry in the rail without leaving Today", async ({
	page,
}) => {
	await page.goto("/library");
	await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

	// Click an in-focus project (Projects stay mock-backed, so present in preview).
	const inFocus = page
		.getByRole("heading", { name: /In focus/i })
		.locator("xpath=ancestor::section");
	await inFocus.getByRole("button", { name: /API v2 migration/i }).click();

	// Stays on Today (overview heading remains) — the detail opens in the shared
	// rail in place, rather than switching to the collection view.
	await expect(page).toHaveURL(/\/library\?id=/);
	await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
	const panel = page.getByRole("complementary", {
		name: /API v2 migration details/i,
	});
	await expect(
		panel.getByRole("heading", { name: /API v2 migration/i }),
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
