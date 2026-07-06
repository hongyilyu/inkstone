import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities } from "./seed.js";

test("the GTD board's Projects pill offers New Project like /library/projects", async ({
	page,
	core,
	workspace,
}) => {
	seedEntities(
		dbPathFor(workspace.path),
		[
			{
				id: "01900000-0000-7000-8000-0000000000b1",
				type: "project",
				data: { name: "Ship QA", status: "active", outcome: "All green." },
			},
		],
		[],
	);
	await page.goto(`${core.url}/library/gtd`);
	await page.getByRole("button", { name: /^Projects/ }).click();
	await expect(page.getByText("Ship QA")).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole("button", { name: /New Project/i }),
	).toBeVisible();
});
