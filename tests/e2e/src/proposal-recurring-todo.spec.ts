import path from "node:path";
import { expect, test } from "./fixtures.js";
import { dbPathFor, sqliteScalar } from "./seed.js";
import { PROPOSE_WORKER_CMD, REPO_ROOT } from "./spawnCore.js";

/**
 * Agent propose → accept of a `create_todo` carrying a recurrence rule
 * (interval/unit/anchor + end.after_count, ADR-0037 slimmed by ADR-0039),
 * end-to-end through a real browser and real Core.
 *
 * This pins the seam the single-source field-schema refactor reshaped most: the
 * recurrence rule's SCHEMA is generated from `MutationKind::payload_spec` (the
 * same source the agent tool surface derives from), while its VALIDATION on the
 * decide path is the hand-written `validate_recurrence` hook (cross-field, so it
 * stays a hook rather than a flat spec walk). The existing `todo-recurrence`
 * spec covers the user `entity/mutate` CRUD path; this covers the AGENT
 * propose→park→decide→apply path, which the CRUD spec does not.
 *
 * The strong assertion reads the DB ground truth — `data.recurrence` reached
 * tier 2 — so a schema regression that let a doomed rule through, or a validator
 * regression that wrongly rejected a valid rule on accept, can't pass.
 */
test.use({
	coreOptions: {
		workerCmd: PROPOSE_WORKER_CMD,
		proposalParamsFile: path.join(
			REPO_ROOT,
			"tests/e2e/fixtures/recurring-todo-proposal.json",
		),
	},
});

test("agent-proposed recurring Todo applies and the recurrence rule persists", async ({
	chat,
	workspace,
}) => {
	await chat.goto();

	await chat.send("I have to submit the weekly status report every week.");

	const card = chat.proposalCard();
	await expect(card).toBeVisible({ timeout: 15_000 });
	await expect(card).toContainText("Submit the weekly status report");

	const add = card.getByRole("button", { name: /add todo/i });
	await expect(add).toBeEnabled();
	await add.click();

	await expect(card).toContainText(/added/i, { timeout: 15_000 });
	await chat.waitForAssistantText(/done.*added it/i);

	// DB ground truth: the accepted Todo's recurrence rule reached tier 2 intact
	// through the agent decide path — proving the `HookValidated` recurrence
	// validation accepted the full rule, not just that the UI rendered it.
	const dbPath = dbPathFor(workspace.path);
	const recurrenceField = (field: string) =>
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.recurrence.${field}') FROM entities WHERE type='todo' AND json_extract(data,'$.title')='Submit the weekly status report';`,
		);
	expect(recurrenceField("interval")).toBe("1");
	expect(recurrenceField("unit")).toBe("week");
	expect(recurrenceField("anchor")).toBe("due_at");
	// The nested end sub-object survives too (the deepest part of the rule,
	// spec-generated) — proves a doomed rule didn't slip through and a valid one
	// wasn't wrongly rejected on the agent decide path.
	expect(recurrenceField("end.after_count")).toBe("10");
});
