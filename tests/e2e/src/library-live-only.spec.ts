import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities } from "./seed.js";

/**
 * Full-system proof that the Library is LIVE-ONLY (issue #119): the preview mock
 * fixture (`apps/web/src/data/mock/entities.ts`) and its merge path are gone, so
 * the Library renders Core's `entity/list` and nothing else.
 *
 * Two halves:
 *  1. Empty Core ⇒ the Library teaches its empty state. No preview rows leak in
 *     (the old fixture seeded "Priya Nair", "API v2 migration", etc.), and the
 *     mock-only affordances are absent — no "Needs review" section on Today and
 *     no "Captured from" footer in a detail rail (both read fixture-only fields
 *     Core has no read path for: EntitySource provenance, an accepted-but-
 *     unconfirmed flag).
 *  2. Seeded Core ⇒ live rows are the whole truth; the Person detail rail shows
 *     the live fields only (name, note), never the dropped descriptive fields
 *     (role / relationship / email had no Core read path).
 *
 * Determinism: no Run is started; the default gate-fixture Worker never spawns.
 */

const PERSON = "01900000-0000-7000-8000-0000000c0001";

test("with no Core data the Library shows its empty state, not preview rows", async ({
	page,
	core,
}) => {
	await page.goto(`${core.url}/library`);

	// The empty state teaches; it is not a snapshot of preview fixtures.
	await expect(
		page.getByRole("heading", { name: /your library is empty/i }),
	).toBeVisible({ timeout: 15_000 });

	// None of the old mock preview rows survive the fixture removal.
	await expect(page.getByText("Priya Nair")).toHaveCount(0);
	await expect(page.getByText("API v2 migration")).toHaveCount(0);

	// The "Needs review" digest was a mock-only affordance (needsReview had no
	// Core read path) — it must never render.
	await expect(
		page.getByRole("heading", { name: /needs review/i }),
	).toHaveCount(0);
});

test("an empty collection teaches instead of falling back to preview rows", async ({
	page,
	core,
}) => {
	// People is empty in Core; the collection must be empty, not mock-populated.
	await page.goto(`${core.url}/library/people`);
	const collection = page.getByRole("region", { name: /people/i });
	await expect(collection).toBeVisible({ timeout: 15_000 });
	await expect(collection.getByText("Priya Nair")).toHaveCount(0);
	await expect(collection.getByText("Dana Osei")).toHaveCount(0);
});

test("a live Person detail rail shows only live fields, no dropped descriptors or capture footer", async ({
	page,
	core,
	workspace,
}) => {
	seedEntities(dbPathFor(workspace.path), [
		{
			id: PERSON,
			type: "person",
			data: { name: "Quinn Alvarez", note: "Leads the platform guild" },
		},
	]);

	await page.goto(`${core.url}/library/people?id=${PERSON}`);
	const detail = page.getByRole("complementary", {
		name: /Quinn Alvarez details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Live fields render: the note appears in the body.
	await expect(
		detail.getByText("Leads the platform guild", { exact: true }),
	).toBeVisible();

	// The dropped mock-only Person descriptors never get a label (they had no
	// Core read path: role / relationship / email).
	await expect(detail.getByText("Email", { exact: true })).toHaveCount(0);

	// "Captured from" footer was mock-only (EntitySource has no read RPC).
	await expect(detail.getByText(/captured from/i)).toHaveCount(0);
});
