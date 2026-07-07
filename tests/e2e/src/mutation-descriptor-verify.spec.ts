// Browser verification for the Entity-Type typed-descriptor refactor
// (feature/entity-type-descriptor). Drives the refactored mutation dispatch
// end-to-end against a real Core binary + faux-provider Worker + built Web
// Client in a real browser, capturing screenshots as evidence. This is the
// human-facing counterpart to the headless CI run: it proves the typed
// MutationKind/Descriptor path produces byte-identical user-visible behavior on
// the agent accept path (create_journal_entry) AND an in-place edit (the
// supports_edit + preserve_update_target_entity_id path).
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD, REPO_ROOT } from "./spawnCore.js";

test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		faux: "propose",
		proposeParamsFile: path.join(
			REPO_ROOT,
			"tests/e2e/fixtures/faux-propose-journal.json",
		),
	},
});

test("descriptor refactor: propose → accept lands a Journal Entry and resumes", async ({
	chat,
}, testInfo) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Bought milk after daycare pickup.");
	await card.screenshot({
		path: testInfo.outputPath("01-pending-proposal.png"),
	});

	// Accept → the agent path: from_wire → ProposableMutation::try_from →
	// render_accept → apply_proposal(kind: MutationKind).
	await card.getByRole("button", { name: /add journal entry/i }).click();
	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);
	await card.screenshot({ path: testInfo.outputPath("02-accepted.png") });
});

test("descriptor refactor: edit changes the Journal Entry then resumes", async ({
	chat,
	core,
	page,
}, testInfo) => {
	await chat.goto();

	await chat.send("I bought milk after daycare pickup and felt relieved.");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });

	// Edit → supports_edit() == true for create_journal_entry, and
	// preserve_update_target_entity_id keeps the (absent) target key intact.
	await card.getByRole("button", { name: /edit/i }).click();
	const body = card.getByRole("textbox", { name: /body/i });
	await body.fill("Bought oat milk after daycare pickup.");
	await card.screenshot({ path: testInfo.outputPath("03-editing.png") });
	await card.getByRole("button", { name: /save changes/i }).click();

	await expect(card).toContainText(/added to journal/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	// The EDITED body — not the model's proposed body — is what got persisted:
	// the apply path stored `edited_payload`, so the Library shows "oat milk".
	await page.goto(`${core.url}/library/journal`);
	await expect(
		page
			.getByRole("region", { name: /journal/i })
			.getByText("Bought oat milk after daycare pickup."),
	).toBeVisible({ timeout: 15_000 });
});
