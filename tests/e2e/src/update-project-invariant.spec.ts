import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";
import { PROPOSE_WORKER_CMD } from "./spawnCore.js";

/**
 * Full-system coverage for `validate_update_project`'s status↔timestamp invariant
 * (ADR-0031), which the entities.rs refactor rewired to run AFTER the kind's full
 * `payload_spec().check()` on BOTH the user `entity/mutate` path and the agent
 * `proposal/decide` path. Two cases pin the two sides of that one hook:
 *
 *  1. Editor → entity/mutate: completing a Project co-stamps `completed_at`, so the
 *     invariant PASSES and Core persists `status=completed` with the timestamp.
 *     (library-crud.spec.ts only exercises active→on_hold, which never touches the
 *     completed_at branch the refactor moved.)
 *  2. Agent proposal → accept → proposal/decide: an `update_project` proposing
 *     `status:"completed"` with NO `completed_at` is REJECTED by the same invariant
 *     before apply — the card surfaces the error and the DB is left untouched. This
 *     is the branch that would silently apply a malformed Project if the hook were
 *     dropped from the update path during the refactor.
 */

const PROJECT_COMPLETE = "01900000-0000-7000-8000-000000030001";

test("complete a seeded Project via the rail editor → update_project stamps completed_at", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	seedEntities(dbPath, [
		{
			id: PROJECT_COMPLETE,
			type: "project",
			data: { name: "Ship the redesign", status: "active" },
		},
	]);

	await page.goto(`${core.url}/library/projects?id=${PROJECT_COMPLETE}`);
	const detail = page.getByRole("complementary", {
		name: /Ship the redesign details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /edit project/i }).click();
	await detail.getByLabel("Status").selectOption("completed");
	await detail.getByRole("button", { name: /^save$/i }).click();

	// Post-save signal: the detail VIEW shows the new status, present only after
	// `entity/mutate` resolved (the invariant accepted the completed_at co-stamp)
	// and the Library re-read. `.first()` because the label appears twice.
	await expect(detail.getByText("Completed").first()).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: the invariant's PASS branch persisted both the status and a
	// non-null completed_at (the editor's co-stamp), proving check()-then-invariant
	// accepts a valid completion on the update path.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.status') FROM entities WHERE id='${PROJECT_COMPLETE}';`,
		),
	).toBe("completed");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entities WHERE id='${PROJECT_COMPLETE}' AND json_extract(data,'$.completed_at') IS NOT NULL;`,
		),
	).toBe("1");
});

const proposalDir = mkdtempSync(
	path.join(tmpdir(), "inkstone-update-project-proposal-"),
);
const proposalParamsFile = path.join(proposalDir, "proposal.json");
const PROJECT_PROPOSED = "01900000-0000-7000-8000-000000030002";

test.afterAll(() => {
	rmSync(proposalDir, { recursive: true, force: true });
});

test.describe("agent-proposed update_project", () => {
	test.use({
		coreOptions: {
			workerCmd: PROPOSE_WORKER_CMD,
			proposalParamsFile,
		},
	});

	test("accepting an update_project that violates the status↔timestamp invariant is rejected before apply", async ({
		chat,
		workspace,
	}) => {
		const dbPath = dbPathFor(workspace.path);
		seedEntities(dbPath, [
			{
				id: PROJECT_PROPOSED,
				type: "project",
				data: { name: "Audit the billing flow", status: "active" },
			},
		]);
		// The worker parks this proposal verbatim; Core validates it on Decision
		// (propose-time is deliberately un-validated, ADR-0025). `status:"completed"`
		// with no `completed_at` is exactly what `validate_update_project`'s invariant
		// must reject.
		writeFileSync(
			proposalParamsFile,
			JSON.stringify({
				mutation_kind: "update_project",
				payload: {
					entity_id: PROJECT_PROPOSED,
					name: "Audit the billing flow",
					status: "completed",
				},
				rationale: "mark the audit complete",
			}),
		);

		await chat.goto();
		await chat.send("Mark the billing audit as done.");

		const card = chat.proposalCard();
		await expect(card).toBeVisible({ timeout: 15_000 });

		// Accept the proposal — Core runs entities::validate on the decide path.
		await card.getByRole("button", { name: /add|update|apply/i }).click();

		// The invariant rejects with invalid_params → the card flips to the error
		// state and surfaces the retry alert rather than a success confirmation.
		await expect(card).toHaveAttribute("data-proposal-status", "error", {
			timeout: 15_000,
		});
		await expect(card.getByRole("alert")).toBeVisible();

		// DB ground truth: the rejected decide wrote nothing — the Project is still
		// active with no completed_at (apply never ran).
		expect(
			sqliteScalar(
				dbPath,
				`SELECT json_extract(data,'$.status') FROM entities WHERE id='${PROJECT_PROPOSED}';`,
			),
		).toBe("active");
		expect(
			sqliteScalar(
				dbPath,
				`SELECT count(*) FROM entities WHERE id='${PROJECT_PROPOSED}' AND json_extract(data,'$.completed_at') IS NOT NULL;`,
			),
		).toBe("0");
	});
});
