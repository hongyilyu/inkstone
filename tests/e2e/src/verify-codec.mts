/**
 * Manual browser-verify driver (NOT a test — run with tsx). Spawns a real Core
 * serving the built SPA, seeds entities, and drives the codec-backed Library
 * editors in a headed-capable chromium, screenshotting key states so a human can
 * confirm the per-Entity-Type codec works in the actual app. Cleans up Core +
 * tempdir on exit.
 */
import { chromium } from "@playwright/test";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";
import { spawnCore } from "./spawnCore.js";

const SHOTS = "/tmp/codec-verify";

async function main() {
	const core = await spawnCore({ workerCmd: undefined });
	const dbPath = dbPathFor(core.workspaceDir);
	const log = (m: string) => process.stdout.write(`[verify] ${m}\n`);

	// Seed one of each kind, including a Project with an un-rendered review_every
	// and a Todo with note+project+due (to exercise the codec's two asymmetries).
	const PROJECT = "01900000-0000-7000-8000-00000000ab01";
	const TODO = "01900000-0000-7000-8000-00000000ab02";
	const PERSON = "01900000-0000-7000-8000-00000000ab03";
	const BOOKMARK = "01900000-0000-7000-8000-00000000ab04";
	seedEntities(dbPath, [
		{
			id: PROJECT,
			type: "project",
			data: {
				name: "Launch the beta",
				status: "active",
				outcome: "Beta in 50 hands",
				review_every: { interval: 2, unit: "week" },
				next_review_at: "2026-07-01T00:00:00",
			},
		},
		{
			id: TODO,
			type: "todo",
			data: {
				title: "Write the changelog",
				status: "active",
				note: "Cover the codec refactor",
				project_id: PROJECT,
				due_at: "2026-07-20T00:00:00",
			},
		},
		{ id: PERSON, type: "person", data: { name: "Jordan Lee", note: "PM" } },
		{
			id: BOOKMARK,
			type: "bookmark",
			data: { title: "Effect docs", url: "https://effect.website" },
		},
	]);

	const browser = await chromium.launch();
	const page = await browser.newPage({
		viewport: { width: 1280, height: 900 },
	});

	try {
		// 1) Library Todos collection (codec parse() renders the live rows).
		await page.goto(`${core.url}/library/todos`);
		await page
			.getByText("Write the changelog")
			.first()
			.waitFor({ timeout: 15_000 });
		await page.screenshot({ path: `${SHOTS}/1-todos-collection.png` });
		log("1 todos collection rendered via codec.parse");

		// 2) Edit the Todo: clear its due date (codec diff/merge sentinel-null).
		await page.goto(`${core.url}/library/todos?id=${TODO}`);
		const todoDetail = page.getByRole("complementary", {
			name: /Write the changelog details/i,
		});
		await todoDetail.waitFor({ timeout: 15_000 });
		await todoDetail.getByRole("button", { name: /edit todo/i }).click();
		await todoDetail.getByLabel("Due").fill("");
		await page.screenshot({ path: `${SHOTS}/2-todo-editor-clear-due.png` });
		await todoDetail.getByRole("button", { name: /^save$/i }).click();
		await todoDetail
			.getByRole("button", { name: /edit todo/i })
			.waitFor({ timeout: 15_000 });
		const dueAfter = sqliteScalar(
			dbPath,
			`SELECT coalesce(json_extract(data,'$.due_at'),'NULL') FROM entities WHERE id='${TODO}';`,
		);
		const noteAfter = sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.note') FROM entities WHERE id='${TODO}';`,
		);
		log(
			`2 after clear-due: due_at=${dueAfter} (want NULL), note=${noteAfter} (want preserved)`,
		);

		// 3) Edit the Project name (codec full-replace must keep review_every).
		await page.goto(`${core.url}/library/projects?id=${PROJECT}`);
		const projDetail = page.getByRole("complementary", {
			name: /Launch the beta details/i,
		});
		await projDetail.waitFor({ timeout: 15_000 });
		await projDetail.getByRole("button", { name: /edit project/i }).click();
		await projDetail.getByLabel("Name").fill("Launch the public beta");
		await projDetail.getByRole("button", { name: /^save$/i }).click();
		await page
			.getByRole("region", { name: /projects/i })
			.getByText("Launch the public beta")
			.waitFor({ timeout: 15_000 });
		const reviewEvery = sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.review_every.interval') FROM entities WHERE id='${PROJECT}';`,
		);
		await page.screenshot({ path: `${SHOTS}/3-project-after-edit.png` });
		log(
			`3 after project name edit: review_every.interval=${reviewEvery} (want 2, survived full-replace)`,
		);

		// 4) Create a new Bookmark (codec build() create path, ungated schema).
		await page.goto(`${core.url}/library/bookmarks`);
		await page.getByRole("button", { name: /new bookmark/i }).click();
		const rail = page.getByRole("complementary", { name: /new bookmark/i });
		await rail.waitFor({ timeout: 15_000 });
		await rail.getByLabel("Title").fill("Inkstone repo");
		await rail.getByLabel("URL").fill("https://example.com/inkstone");
		await page.screenshot({ path: `${SHOTS}/4-bookmark-create.png` });
		await rail.getByRole("button", { name: /^save$/i }).click();
		await page
			.getByRole("region", { name: /bookmarks/i })
			.getByText("Inkstone repo")
			.waitFor({ timeout: 15_000 });
		const bmCount = sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entities WHERE type='bookmark' AND json_extract(data,'$.title')='Inkstone repo';`,
		);
		log(`4 bookmark created: count=${bmCount} (want 1)`);

		const ok =
			dueAfter === "NULL" &&
			noteAfter === "Cover the codec refactor" &&
			reviewEvery === "2" &&
			bmCount === "1";
		log(ok ? "ALL CHECKS PASS ✓" : "A CHECK FAILED ✗");
		process.exitCode = ok ? 0 : 1;
	} finally {
		await browser.close();
		await core.shutdown();
	}
}

main().catch((e) => {
	process.stderr.write(`${e?.stack ?? e}\n`);
	process.exitCode = 1;
});
