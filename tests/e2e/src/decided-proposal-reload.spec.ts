import path from "node:path";
import { expect, test } from "./fixtures.js";
import { dbPathFor, sqliteScalar } from "./seed.js";
import { PROPOSE_WORKER_CMD, REPO_ROOT } from "./spawnCore.js";

/**
 * Regression-pinning e2e for an already-shipped behavior (ADR-0044 entity_id
 * amendment, re-landed on the ADR-0045 segment timeline): a DECIDED proposal card
 * NAMES the Entity the accept created and offers a "View in Library" deep-link —
 * and that NAME + link SURVIVE a page reload.
 *
 * The entity_id that names the card now rides on the rehydrated `proposal` SEGMENT
 * (ADR-0045 folded the former `MessageView.proposal` field into `segments[]`).
 * Core resolves it deterministically in `segment_rows_for_run`; the web card reads
 * it onto the seeded `PendingProposal` (`rehydrateDecidedProposals`) and resolves
 * the name from the warm library-items cache. This test exercises the FULL stack
 * (built SPA + Core + the propose-worker fixture) and asserts the named card BOTH
 * right after accept AND after `chat.reload()`.
 *
 * The after-reload assertion is the durable pin: a regression that drops entity_id
 * from the wire, or that stops the card naming/linking, makes the reloaded card
 * degrade back to "Added Person." with no "Lev Petrov" and no link. The DB
 * ground-truth assertion proves the accept actually persisted the Person.
 */
test.use({
	coreOptions: {
		workerCmd: PROPOSE_WORKER_CMD,
		proposalParamsFile: path.join(
			REPO_ROOT,
			"tests/e2e/fixtures/create-person-proposal.json",
		),
	},
});

test("a decided proposal card still names the created Entity and links to the Library after a reload", async ({
	chat,
	workspace,
}) => {
	await chat.goto();

	await chat.send("Remember Lev Petrov from the conference.");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });

	// Accept the create_person proposal (acceptLabel "Add Person").
	await card.getByRole("button", { name: /add person/i }).click();

	// Decided state reached (acceptedCopy "Added Person.").
	await expect(card).toContainText(/added/i, { timeout: 15_000 });

	// The decided card NAMES the created entity and offers the Library deep-link.
	await expect(card).toContainText("Lev Petrov");
	await expect(
		card.getByRole("button", { name: /view in library/i }),
	).toBeVisible();

	// RELOAD: the thread is URL-addressable (/thread/<id>, ADR-0042), so the
	// refresh lands back on the same thread and rehydrates from Core.
	await chat.reload();

	// THE PIN: the rehydrated decided card STILL names the entity and keeps the
	// link. The locator re-resolves against the new DOM; the name is read from the
	// library-items cache, which refetches after reload (useLibraryItems), so the
	// card degrades until the refetch lands, then upgrades to the name. The
	// auto-retrying expect awaits that upgrade — correct, not a flake.
	const cardAfter = chat.proposalCard();
	await expect(cardAfter).toContainText("Lev Petrov", { timeout: 15_000 });
	await expect(
		cardAfter.getByRole("button", { name: /view in library/i }),
	).toBeVisible();

	// DB ground truth: the accept actually persisted a Person with that name.
	expect(
		sqliteScalar(
			dbPathFor(workspace.path),
			"SELECT json_extract(data,'$.name') FROM entities WHERE type='person';",
		),
	).toBe("Lev Petrov");
});
