import path from "node:path";
import { expect, test } from "./fixtures.js";
import { dbPathFor, sqliteScalar } from "./seed.js";
import { PROPOSE_WORKER_CMD, REPO_ROOT } from "./spawnCore.js";

/**
 * The keystone loop: an agent proposes a `create_todo` whose extracted title is
 * WRONG ("Email Alce ..."), the user corrects it at the approval gate, and the
 * accepted Entity that reaches tier 2 reflects the EDITED title — not the
 * proposed one.
 *
 * This is the feature's acceptance criterion end-to-end: park → decide(edit) →
 * resume → apply must carry the UI's edited envelope all the way to the DB. The
 * strong assertion reads the DB ground truth (`data.title`), so a regression
 * that applied the original (mis-extracted) proposal instead of the edited one
 * can't pass: the misspelled title would survive and the corrected one wouldn't.
 */
test.use({
	coreOptions: {
		workerCmd: PROPOSE_WORKER_CMD,
		proposalParamsFile: path.join(
			REPO_ROOT,
			"tests/e2e/fixtures/edit-todo-proposal.json",
		),
	},
});

test("agent-proposed Todo with a wrong title is corrected at the gate and the accepted Entity reflects the edited title", async ({
	chat,
	workspace,
}) => {
	await chat.goto();

	await chat.send("I need to email Alice about the migration.");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Email Alce about the migration");

	await card.getByRole("button", { name: /edit/i }).click();
	const title = card.getByRole("textbox", { name: /title/i });
	await title.fill("Email Alice about the migration");
	await card.getByRole("button", { name: /save changes/i }).click();

	await expect(card).toContainText(/added/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	// DB ground truth: the accepted Todo's stored title is the EDITED value, and
	// the mis-extracted one never reached tier 2 — proving the decide(edit) path
	// applied the UI's corrected envelope, not the original proposal.
	const dbPath = dbPathFor(workspace.path);
	expect(
		sqliteScalar(
			dbPath,
			"SELECT json_extract(data,'$.title') FROM entities WHERE type='todo';",
		),
	).toBe("Email Alice about the migration");
	expect(
		sqliteScalar(
			dbPath,
			"SELECT COUNT(*) FROM entities WHERE type='todo' AND json_extract(data,'$.title')='Email Alce about the migration';",
		),
	).toBe("0");
});
