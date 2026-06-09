import { FAUX_WORKER_CMD } from "./spawnCore.js";
import { expect, test } from "./fixtures.js";

/**
 * End-to-end Person proposal (slice 4, ADR-0016/0025) through the real stack —
 * real Core, the real generic interpreter Worker, the real built Web Client in
 * the browser.
 *
 * Offline via the faux provider in propose mode with
 * `INKSTONE_FAUX_PROPOSE_KIND=person` (ADR-0019): turn 1 the faux "model" calls
 * `propose_entity` with a Person (name "Alice"), so Core parks the Run and
 * pushes a `proposal/pending` notification. The chat surface renders the review
 * card with the Person fields and an "Add to People" action. Accepting creates
 * the Person and resumes the Run; the accepted Person then shows up in the
 * Library's live People collection (`entity/list(person)`, slices 2-3).
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose-person",
	},
});

test("accepts a Person proposal and it appears in the library", async ({
	chat,
	core,
	page,
}) => {
	await chat.goto();

	await chat.send("remember Alice from daycare");

	// The review card surfaces with the proposed Person.
	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Alice");

	// Accept: Add to People.
	await card.getByRole("button", { name: /add to people/i }).click();

	// Card transitions to its accepted state and the Run resumes to completion.
	await expect(card).toContainText(/added to people/i, { timeout: 15_000 });

	// The Library's People collection reads live from Core via entity/list
	// (slices 2-3): the accepted "Alice" Person is listed there.
	await page.goto(`${core.url}/library/people`);
	await expect(
		page.getByRole("region", { name: /people/i }).getByText("Alice"),
	).toBeVisible({ timeout: 15_000 });
});

test("edits the Person name then resumes", async ({ chat, core, page }) => {
	await chat.goto();

	await chat.send("remember Alice from daycare");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Alice");

	// Edit: open the inline form, retype the name (the primary field for a
	// Person is Name, not the Todo's Title), save.
	await card.getByRole("button", { name: /edit/i }).click();
	const name = card.getByRole("textbox", { name: /name/i });
	await name.fill("Alicia");
	await card.getByRole("button", { name: /save changes/i }).click();

	// The edit decides AND accepts in one step (ADR-0025); the card reaches
	// accepted and the Run resumes to completion.
	await expect(card).toContainText(/added to people/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done — added it/i);

	// The EDITED name (not the model's "Alice") is what persisted: it is the
	// Person listed in the Library's live People collection.
	await page.goto(`${core.url}/library/people`);
	const people = page.getByRole("region", { name: /people/i });
	await expect(people.getByText("Alicia")).toBeVisible({ timeout: 15_000 });
	await expect(people.getByText("Alice", { exact: true })).toHaveCount(0);
});
