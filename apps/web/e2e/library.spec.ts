import { expect, test } from "@playwright/test";

// Web-only e2e (runs against `pnpm preview`, no Core); Core-wired flows live in the full-system harness under `tests/e2e/`.

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
	// Shared WorkspaceShell carries a single `main` landmark, like the chat surface.
	await expect(page.getByRole("main")).toBeVisible();
	// The topic nav (ADR-0054) replaces the flat entity-type rows with the Today hub
	// + the four topic dives; assert the dives are present, not the old kind links.
	const nav = page.getByRole("navigation", { name: /workspace/i });
	await expect(nav.getByRole("link", { name: /gtd/i })).toBeVisible();
	await expect(nav.getByRole("link", { name: /timeline/i })).toBeVisible();
});

test("browses People and opens the detail inspector", async ({ page }) => {
	await page.goto("/library/people");

	await expect(
		page.getByRole("heading", { name: "People", level: 1 }),
	).toBeVisible();
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
	// Projects stay mock-backed, so they render without Core (unlike People/Todos).
	await page.goto("/library/projects");
	await page.getByRole("button", { name: /api v2 migration/i }).click();
	await expect(page).toHaveURL(/\/library\/projects\?id=proj_apiv2/);

	// Detail opens in the shared right rail (a complementary landmark).
	const panel = page.getByRole("complementary", {
		name: /api v2 migration details/i,
	});
	await expect(
		panel.getByRole("heading", { name: /api v2 migration/i }),
	).toBeVisible();

	// The bay toggle is the only dismiss; assert its aria-pressed, not pixels.
	const toggle = page.getByRole("button", { name: /details panel/i });
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");

	// Model A: collapsing hides the panel but keeps the selection (`?id`, current row, bay all stay) so it can reopen.
	await expect(page).toHaveURL(/\/library\/projects\?id=proj_apiv2/);
	await expect(
		page.getByRole("button", { name: /api v2 migration/i }),
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

	// Card's right edge sits a gutter inside the viewport, never flush, so the frame stays visible (jsdom has no CSS).
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
	// Projects stay mock-backed, so this runs without Core.
	await page.goto("/library/projects");
	await expect(
		page.getByRole("heading", { name: "Projects", level: 1 }),
	).toBeVisible();

	const toggle = page.getByRole("button", { name: /details panel/i });
	await expect(toggle).toHaveCount(0);

	await page.getByRole("button", { name: /api v2 migration/i }).click();
	await expect(toggle).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: /api v2 migration details/i }),
	).toBeVisible();
});

test("drops the bay when navigating away deselects", async ({ page }) => {
	await page.goto("/library/projects?id=proj_apiv2");
	const toggle = page.getByRole("button", { name: /details panel/i });
	await expect(toggle).toBeVisible();

	// Navigating to another topic via the nav drops `?id` → nothing selected → bay + toggle disappear.
	await page
		.getByRole("navigation", { name: /workspace/i })
		.getByRole("link", { name: /gtd/i })
		.click();
	await expect(page).toHaveURL(/\/library\/gtd$/);
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
	await page.goto("/library/projects?id=proj_apiv2");

	await expect(
		page.getByRole("button", { name: /details panel/i }),
	).toBeVisible();
	await expect(
		page
			.getByRole("complementary", { name: /api v2 migration details/i })
			.getByRole("heading", { name: /api v2 migration/i }),
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
	// The homepage rail mounts regardless of data, so its bay + toggle always show.
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

	// Projects stay mock-backed, so an in-focus project is present in preview.
	const inFocus = page
		.getByRole("heading", { name: /In focus/i })
		.locator("xpath=ancestor::section");
	await inFocus.getByRole("button", { name: /API v2 migration/i }).click();

	// Stays on Today — the detail opens in the rail in place, not the collection view.
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
