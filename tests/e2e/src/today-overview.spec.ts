import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities } from "./seed.js";

/**
 * Full-system Today overview (`/library` index, ADR-0031): the landing view over
 * live Library data. It had no assertion at any layer — the mock-e2e only checked
 * the heading, and there is no `TodayOverview` unit test. This seeds canonical
 * entities and asserts the derived sections render from Core's `entity/list`:
 * "Recently captured", "In focus" (active Projects), and a select-in-place that
 * opens an entity's detail rail without leaving Today.
 *
 * Today's sections aren't ARIA landmarks (no `aria-label`), so they're located by
 * their heading text; rows are buttons carrying the entity title. The Library is
 * live-only (`useLibraryItems` reads Core; no preview fixtures), so the seeded
 * rows are the entire Library surface.
 *
 * Determinism: no Run is started; the default gate-fixture Worker never spawns.
 */

const PROJECT = "01900000-0000-7000-8000-000000020001";
const TODO = "01900000-0000-7000-8000-000000020002";
const PERSON = "01900000-0000-7000-8000-000000020003";

test("Today renders its header and the In focus section from live active Projects", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: PROJECT,
			type: "project",
			data: {
				name: "Plan the offsite",
				status: "active",
				outcome: "Book venue + agenda",
			},
		},
		{
			id: TODO,
			type: "todo",
			data: { title: "Email the caterer", status: "active" },
		},
		{
			id: PERSON,
			type: "person",
			data: { name: "Jordan Lee", note: "Venue contact" },
		},
	]);

	await page.goto(`${core.url}/library`);

	// The Today header always renders once the live library read resolves.
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({ timeout: 15_000 });

	// "In focus" lists active Projects (derived from live status === "active").
	// The Project also appears under "Recently captured", so assert presence with
	// `.first()` rather than a section landmark (Today's sections aren't regions).
	await expect(page.getByRole("heading", { name: /in focus/i })).toBeVisible({
		timeout: 15_000,
	});
	await expect(
		page.getByRole("button", { name: /Plan the offsite/ }).first(),
	).toBeVisible();

	// "Recently captured" surfaces the seeded live entities.
	await expect(
		page.getByRole("heading", { name: /recently captured/i }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Email the caterer/ }).first(),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Jordan Lee/ }).first(),
	).toBeVisible();
});

test("selecting an entity on Today opens its detail rail in place (?id, no navigation away)", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: PERSON,
			type: "person",
			data: { name: "Jordan Lee", note: "Venue contact" },
		},
	]);

	await page.goto(`${core.url}/library`);
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible({
		timeout: 15_000,
	});

	// Click the captured Person row; Today stays mounted and the rail shows detail.
	await page
		.getByRole("button", { name: /Jordan Lee/ })
		.first()
		.click();

	await expect(page).toHaveURL(/\/library\?id=/);
	await expect(
		page.getByRole("heading", { name: "Today", level: 1 }),
	).toBeVisible();
	const detail = page.getByRole("complementary", {
		name: /Jordan Lee details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });
	// The note renders in the body Field; `exact` excludes the header subtitle
	// ("Person · Venue contact"), which now derives from the same note.
	await expect(
		detail.getByText("Venue contact", { exact: true }),
	).toBeVisible();
});
