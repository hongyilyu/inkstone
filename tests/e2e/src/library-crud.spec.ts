import { expect, test } from "./fixtures.js";
import { dbPathFor, seedEntities, sqliteScalar } from "./seed.js";

/**
 * Full-system Library direct CRUD (ADR-0033 `entity/mutate`): the user write path
 * the rail editors drive WITHOUT a Proposal — create, update, and delete applied
 * straight to tier 2 by Core, no Worker/LLM in the loop. Previously covered only
 * by `useEntityMutation` unit tests (mocked transport); this exercises the real
 * editor → Core `entity/mutate` → re-read round-trip through the browser, and
 * asserts the DB ground truth so an apply/validation regression can't pass.
 *
 * Determinism: no Run is started, so the default gate-fixture Worker is never
 * spawned — these are pure Core writes.
 */

const PROJECT_MIGRATION = "01900000-0000-7000-8000-0000000000d1";

test("create a Todo via the rail editor → entity/mutate writes it and the row appears", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);

	await page.goto(`${core.url}/library/todos`);
	await page.getByRole("button", { name: /new todo/i }).click();

	const rail = page.getByRole("complementary", { name: /new todo/i });
	await expect(rail).toBeVisible({ timeout: 15_000 });
	await rail.getByLabel("Title").fill("Water the office plants");
	await rail.getByLabel("Note").fill("The fern by the window is wilting");
	await rail.getByRole("button", { name: /^save$/i }).click();

	// The new Todo lands in the live collection.
	const collection = page.getByRole("region", { name: /todos/i });
	await expect(collection.getByText("Water the office plants")).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: exactly one Todo with that title, created_by the user.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entities WHERE type='todo' AND created_by='user' AND json_extract(data,'$.title')='Water the office plants';`,
		),
	).toBe("1");
});

test("edit a seeded Todo via the rail editor → update_todo persists across reload", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const TODO = "01900000-0000-7000-8000-0000000000e1";
	seedEntities(dbPath, [
		{
			id: TODO,
			type: "todo",
			data: { title: "Draft the memo", status: "active" },
		},
	]);

	await page.goto(`${core.url}/library/todos?id=${TODO}`);
	const detail = page.getByRole("complementary", {
		name: /Draft the memo details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /edit todo/i }).click();
	const title = detail.getByLabel("Title");
	await expect(title).toHaveValue("Draft the memo");
	await title.fill("Draft the launch memo");
	await detail.getByRole("button", { name: /^save$/i }).click();

	// Live re-read shows the new title; the old one is gone.
	const collection = page.getByRole("region", { name: /todos/i });
	await expect(collection.getByText("Draft the launch memo")).toBeVisible({
		timeout: 15_000,
	});
	await expect(
		collection.getByText("Draft the memo", { exact: true }),
	).toHaveCount(0);

	// Persisted in Core (not just optimistic): the row's data carries the new title.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.title') FROM entities WHERE id='${TODO}';`,
		),
	).toBe("Draft the launch memo");

	// Survives a reload (proves the write reached tier 2, not just the cache).
	await page.reload();
	await expect(
		page
			.getByRole("region", { name: /todos/i })
			.getByText("Draft the launch memo"),
	).toBeVisible({ timeout: 15_000 });
});

test("delete a seeded Person via the inline confirm → delete_person removes it", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const PERSON = "01900000-0000-7000-8000-0000000000f1";
	seedEntities(dbPath, [
		{ id: PERSON, type: "person", data: { name: "Dana Holt" } },
	]);

	await page.goto(`${core.url}/library/people?id=${PERSON}`);
	const detail = page.getByRole("complementary", {
		name: /Dana Holt details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Inline (non-modal) two-step delete confirm (ADR-0033, "approval is sacred").
	await detail.getByRole("button", { name: /delete person/i }).click();
	await detail.getByRole("button", { name: /^delete$/i }).click();

	// Row is gone from the collection and the rail closed (route dropped ?id).
	const collection = page.getByRole("region", { name: /people/i });
	await expect(collection.getByText("Dana Holt")).toHaveCount(0, {
		timeout: 15_000,
	});

	// DB ground truth: the Person no longer exists.
	expect(
		sqliteScalar(dbPath, `SELECT count(*) FROM entities WHERE id='${PERSON}';`),
	).toBe("0");
});

test("delete a Project unsets project_id on its owning Todo (Core cascade)", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const TODO = "01900000-0000-7000-8000-0000000000d2";
	seedEntities(dbPath, [
		{
			id: PROJECT_MIGRATION,
			type: "project",
			data: { name: "Retire the legacy API", status: "active" },
		},
		{
			id: TODO,
			type: "todo",
			data: {
				title: "Cut over traffic",
				status: "active",
				project_id: PROJECT_MIGRATION,
			},
		},
	]);

	await page.goto(`${core.url}/library/projects?id=${PROJECT_MIGRATION}`);
	const detail = page.getByRole("complementary", {
		name: /Retire the legacy API details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /delete project/i }).click();
	await detail.getByRole("button", { name: /^delete$/i }).click();

	const collection = page.getByRole("region", { name: /projects/i });
	await expect(collection.getByText("Retire the legacy API")).toHaveCount(0, {
		timeout: 15_000,
	});

	// Core cascade (ADR-0031): the Project is gone and its Todo lost project_id.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entities WHERE id='${PROJECT_MIGRATION}';`,
		),
	).toBe("0");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT coalesce(json_extract(data,'$.project_id'),'NULL') FROM entities WHERE id='${TODO}';`,
		),
	).toBe("NULL");
});

test("edit a seeded Person via the rail editor → update_person full-replace persists", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const PERSON = "01900000-0000-7000-8000-000000010001";
	seedEntities(dbPath, [
		{
			id: PERSON,
			type: "person",
			data: { name: "Sam Rivera", note: "Designer" },
		},
	]);

	await page.goto(`${core.url}/library/people?id=${PERSON}`);
	const detail = page.getByRole("complementary", {
		name: /Sam Rivera details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /edit person/i }).click();
	await detail.getByLabel("Note").fill("Lead designer, design systems");
	await detail.getByRole("button", { name: /^save$/i }).click();

	// Post-save signal: the editor closes back to the detail VIEW showing the new
	// note — visible only after `entity/mutate` resolved and the Library re-read.
	// (The collection title is unchanged here, so it can't gate the save.) `exact`
	// targets the note BODY paragraph only: the header subtitle renders the same
	// note as "Person · <note>" (libraryItemSubtitle), so a substring match is
	// ambiguous under strict mode once both re-render.
	await expect(
		detail.getByText("Lead designer, design systems", { exact: true }),
	).toBeVisible({
		timeout: 15_000,
	});

	// Full-replace update keeps name, swaps note.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.name') FROM entities WHERE id='${PERSON}';`,
		),
	).toBe("Sam Rivera");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.note') FROM entities WHERE id='${PERSON}';`,
		),
	).toBe("Lead designer, design systems");
});

test("edit a seeded Project's status via the rail editor → update_project persists", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const PROJECT = "01900000-0000-7000-8000-000000010002";
	seedEntities(dbPath, [
		{
			id: PROJECT,
			type: "project",
			data: { name: "Spring launch", status: "active" },
		},
	]);

	await page.goto(`${core.url}/library/projects?id=${PROJECT}`);
	const detail = page.getByRole("complementary", {
		name: /Spring launch details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /edit project/i }).click();
	await detail.getByLabel("Status").selectOption("on_hold");
	await detail.getByRole("button", { name: /^save$/i }).click();

	// Post-save signal: the detail VIEW shows the new status — both the header
	// subtitle and the badge read "On hold", present only after `entity/mutate`
	// resolved and the Library re-read. (The collection title is unchanged here,
	// so it can't gate the save.) `.first()` because the text appears twice.
	await expect(detail.getByText("On hold").first()).toBeVisible({
		timeout: 15_000,
	});

	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.status') FROM entities WHERE id='${PROJECT}';`,
		),
	).toBe("on_hold");
});

test("delete a seeded Todo via the inline confirm → delete_todo removes it", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const TODO = "01900000-0000-7000-8000-000000010003";
	seedEntities(dbPath, [
		{
			id: TODO,
			type: "todo",
			data: { title: "Cancel the old subscription", status: "active" },
		},
	]);

	await page.goto(`${core.url}/library/todos?id=${TODO}`);
	const detail = page.getByRole("complementary", {
		name: /Cancel the old subscription details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /delete todo/i }).click();
	await detail.getByRole("button", { name: /^delete$/i }).click();

	await expect(
		page
			.getByRole("region", { name: /todos/i })
			.getByText("Cancel the old subscription"),
	).toHaveCount(0, { timeout: 15_000 });
	expect(
		sqliteScalar(dbPath, `SELECT count(*) FROM entities WHERE id='${TODO}';`),
	).toBe("0");
});

test("cancel the inline delete confirm → no write, the Todo survives", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const TODO = "01900000-0000-7000-8000-000000010007";
	seedEntities(dbPath, [
		{
			id: TODO,
			type: "todo",
			data: { title: "Keep this task", status: "active" },
		},
	]);

	await page.goto(`${core.url}/library/todos?id=${TODO}`);
	const detail = page.getByRole("complementary", {
		name: /Keep this task details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Reveal the inline confirm, then back out — the shell resets `confirmingDelete`
	// (and `del.reset()`) so no `entity/mutate` is sent (ADR-0033, "approval is sacred").
	await detail.getByRole("button", { name: /delete todo/i }).click();
	await expect(detail.getByText(/delete this todo\?/i)).toBeVisible();
	await detail.getByRole("button", { name: /cancel/i }).click();

	// Confirm dismissed, the delete affordance is back, the rail stayed open (?id kept).
	await expect(detail.getByText(/delete this todo\?/i)).toHaveCount(0);
	await expect(
		detail.getByRole("button", { name: /delete todo/i }),
	).toBeVisible();
	await expect(detail).toBeVisible();

	// DB ground truth: the Todo is untouched — cancel never wrote.
	expect(
		sqliteScalar(dbPath, `SELECT count(*) FROM entities WHERE id='${TODO}';`),
	).toBe("1");
});

test("edit then delete a seeded Journal Entry via the rail editor (update + delete)", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const JE = "01900000-0000-7000-8000-000000010004";
	seedEntities(dbPath, [
		{
			id: JE,
			type: "journal_entry",
			data: {
				occurred_at: "2026-06-10T09:00:00",
				body: [{ type: "text", text: "Morning standup ran long." }],
			},
		},
	]);

	await page.goto(`${core.url}/library/journal?id=${JE}`);
	const detail = page.getByRole("complementary", {
		name: /Morning standup ran long. details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Edit: full-replace body via the JournalEntryEditor (ADR-0033 slice-8).
	await detail.getByRole("button", { name: /edit journal entry/i }).click();
	const body = detail.getByLabel("Body");
	await expect(body).toHaveValue("Morning standup ran long.");
	await body.fill("Morning standup ran long; agreed to timebox it.");
	await detail.getByRole("button", { name: /^save$/i }).click();

	const region = page.getByRole("region", { name: /journal/i });
	await expect(
		region.getByText("Morning standup ran long; agreed to timebox it."),
	).toBeVisible({ timeout: 15_000 });
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.body[0].text') FROM entities WHERE id='${JE}';`,
		),
	).toBe("Morning standup ran long; agreed to timebox it.");

	// Delete: reopen the (now-updated) entry and remove it.
	await page.goto(`${core.url}/library/journal?id=${JE}`);
	const detail2 = page.getByRole("complementary", { name: /details/i });
	await expect(detail2).toBeVisible({ timeout: 15_000 });
	await detail2.getByRole("button", { name: /delete journal entry/i }).click();
	await detail2.getByRole("button", { name: /^delete$/i }).click();

	await expect(
		page.getByRole("region", { name: /journal/i }).getByText(/Morning standup/),
	).toHaveCount(0, { timeout: 15_000 });
	expect(
		sqliteScalar(dbPath, `SELECT count(*) FROM entities WHERE id='${JE}';`),
	).toBe("0");
});

test("create a Bookmark via the rail editor → entity/mutate writes it and the row appears", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);

	await page.goto(`${core.url}/library/bookmarks`);
	await page.getByRole("button", { name: /new bookmark/i }).click();

	const rail = page.getByRole("complementary", { name: /new bookmark/i });
	await expect(rail).toBeVisible({ timeout: 15_000 });
	await rail.getByLabel("Title").fill("Effect docs");
	await rail.getByLabel("URL").fill("https://effect.website");
	await rail.getByRole("button", { name: /^save$/i }).click();

	// The new Bookmark lands in the live collection.
	const collection = page.getByRole("region", { name: /bookmarks/i });
	await expect(collection.getByText("Effect docs")).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: exactly one Bookmark with that title, created_by the user.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entities WHERE type='bookmark' AND created_by='user' AND json_extract(data,'$.title')='Effect docs';`,
		),
	).toBe("1");
});

test("edit a seeded Bookmark via the rail editor → update_bookmark persists across reload", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const BOOKMARK = "01900000-0000-7000-8000-000000010005";
	seedEntities(dbPath, [
		{
			id: BOOKMARK,
			type: "bookmark",
			data: { title: "Effect docs", url: "https://effect.website" },
		},
	]);

	await page.goto(`${core.url}/library/bookmarks?id=${BOOKMARK}`);
	const detail = page.getByRole("complementary", {
		name: /Effect docs details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await detail.getByRole("button", { name: /edit bookmark/i }).click();
	const title = detail.getByLabel("Title");
	await expect(title).toHaveValue("Effect docs");
	await title.fill("Effect-TS documentation");
	await detail.getByRole("button", { name: /^save$/i }).click();

	// Live re-read shows the new title; the old one is gone.
	const collection = page.getByRole("region", { name: /bookmarks/i });
	await expect(collection.getByText("Effect-TS documentation")).toBeVisible({
		timeout: 15_000,
	});
	await expect(
		collection.getByText("Effect docs", { exact: true }),
	).toHaveCount(0);

	// Persisted in Core (not just optimistic): the row's data carries the new title.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.title') FROM entities WHERE id='${BOOKMARK}';`,
		),
	).toBe("Effect-TS documentation");

	// Survives a reload (proves the write reached tier 2, not just the cache).
	await page.reload();
	await expect(
		page
			.getByRole("region", { name: /bookmarks/i })
			.getByText("Effect-TS documentation"),
	).toBeVisible({ timeout: 15_000 });
});

test("delete a seeded Bookmark via the inline confirm → delete_bookmark removes it", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const BOOKMARK = "01900000-0000-7000-8000-000000010006";
	seedEntities(dbPath, [
		{
			id: BOOKMARK,
			type: "bookmark",
			data: { title: "Stale link", url: "https://example.com" },
		},
	]);

	await page.goto(`${core.url}/library/bookmarks?id=${BOOKMARK}`);
	const detail = page.getByRole("complementary", {
		name: /Stale link details/i,
	});
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Inline (non-modal) two-step delete confirm (ADR-0033, "approval is sacred").
	await detail.getByRole("button", { name: /delete bookmark/i }).click();
	await detail.getByRole("button", { name: /^delete$/i }).click();

	// Row is gone from the collection and the rail closed (route dropped ?id).
	const collection = page.getByRole("region", { name: /bookmarks/i });
	await expect(collection.getByText("Stale link")).toHaveCount(0, {
		timeout: 15_000,
	});

	// DB ground truth: the Bookmark no longer exists.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entities WHERE id='${BOOKMARK}';`,
		),
	).toBe("0");
});
