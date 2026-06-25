import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqlite } from "./seed.js";

/**
 * Entity backlinks, end-to-end ("Mentioned in", ADR-0050) — the REVERSE of
 * `journal-entry-ref.spec.ts`. That spec opens a Journal Entry and follows an
 * inline ref chip FORWARD to the Person it names. This one stands in the Person's
 * detail and follows the BACKLINK to the Journal Entry that mentions it.
 *
 * It is the full read-path proof for the backlink seam: a real `entity_refs` row
 * (Journal Entry → Person) flows through Core's `entity/backlinks` query →
 * ui-sdk `getBacklinks` → `useEntityBacklinks` → the Inspector's "Mentioned in"
 * section → a working click-through to the source Journal Entry. The unit/
 * component suites cover each hop in isolation; only this spec proves the wire.
 *
 * It supersedes the obsolete "Captured from" footer proof (ADR-0050 retired the
 * `journal_entry`-source footer branch — a JE-anchored Entity now surfaces its
 * origin canonically under "Mentioned in", not in the footer). The surviving
 * `thread`-source footer branch is covered by the EntityDetail unit suite.
 */

const PERSON_ID = "01900000-0000-7000-8000-0000000ba110";
const JOURNAL_ENTRY_ID = "01900000-0000-7000-8000-0000000ba111";
const REF_ID = "01900000-0000-7000-8000-0000000ba112";

test("a Person's detail surfaces the Journal Entry that mentions it and clicks through to it", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedMentionedPerson(dbPath);

	// Open the TARGET (the Person) — not the Journal Entry.
	await page.goto(`${core.url}/library/people?id=${PERSON_ID}`);
	const personDetail = page.getByRole("complementary", {
		name: /Ada Lovelace details/i,
	});
	await expect(personDetail).toBeVisible({ timeout: 15_000 });

	// The backlink read resolves the Journal Entry that references this Person and
	// renders it under "Mentioned in" — the section a Person with no client-side
	// scan would never show before the backlink seam (ADR-0050). Its row title is
	// the JE's body text, the inline ref resolved to the Person's current name.
	const mentionedIn = personDetail
		.getByText(/Mentioned in/i)
		.locator("xpath=following-sibling::*[1]");
	const entryRow = mentionedIn.getByRole("button", {
		name: /Met Ada Lovelace at school\./i,
	});
	await expect(entryRow).toBeVisible({ timeout: 15_000 });

	// Click the backlink → land on the Journal Entry's own detail.
	await entryRow.click();
	await expect(page).toHaveURL(
		new RegExp(`/library/journal\\?id=${JOURNAL_ENTRY_ID}`),
	);
	await expect(
		page.getByRole("complementary", {
			name: /Met Ada Lovelace at school\. details/i,
		}),
	).toBeVisible({ timeout: 15_000 });
});

/**
 * Seed a Person and a Journal Entry that references it via a real `entity_refs`
 * row (the reverse of `journal-entry-ref.spec.ts`'s live proposal apply, landed
 * directly). The JE body weaves an `entity_ref` node carrying the ref id, so its
 * rendered title resolves the chip to the Person's current name — exactly the
 * shape `reference_existing_entity_from_journal_entry` lands.
 */
function seedMentionedPerson(dbPath: string): void {
	seedEntities(dbPath, [
		{
			id: PERSON_ID,
			type: "person",
			data: { name: "Ada Lovelace", note: "Current canonical name" },
		},
		{
			id: JOURNAL_ENTRY_ID,
			type: "journal_entry",
			data: {
				occurred_at: "2026-06-10T10:30:00",
				body: [
					{ type: "text", text: "Met " },
					{ type: "entity_ref", ref_id: REF_ID },
					{ type: "text", text: " at school." },
				],
			},
		},
	]);
	const now = Date.now();
	sqlite(
		dbPath,
		`INSERT INTO entity_refs (id, source_entity_id, target_entity_id, label_snapshot, created_at)
		 VALUES ('${REF_ID}', '${JOURNAL_ENTRY_ID}', '${PERSON_ID}', 'Ada snapshot', ${now});`,
	);
}
