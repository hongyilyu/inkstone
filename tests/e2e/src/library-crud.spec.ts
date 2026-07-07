import { expect, test } from "./fixtures.js";
import { LibraryPage } from "./page-objects/LibraryPage.js";
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
	const library = new LibraryPage(page, core.url);

	await library.gotoCollection("todos");
	await library.newEntity("todo");

	const rail = library.rail(/new todo/i);
	await expect(rail).toBeVisible({ timeout: 15_000 });
	await library.fillField(rail, "Title", "Water the office plants");
	await library.fillField(rail, "Note", "The fern by the window is wilting");
	await library.save(rail);

	// The new Todo lands in the live collection.
	const collection = library.collection(/todos/i);
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
	const library = new LibraryPage(page, core.url);
	const TODO = "01900000-0000-7000-8000-0000000000e1";
	seedEntities(dbPath, [
		{
			id: TODO,
			type: "todo",
			data: { title: "Draft the memo", status: "active" },
		},
	]);

	await library.gotoCollection("todos", TODO);
	const detail = library.rail(/Draft the memo details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await library.enterEdit(detail, "todo");
	const title = library.field(detail, "Title");
	await expect(title).toHaveValue("Draft the memo");
	await title.fill("Draft the launch memo");
	await library.save(detail);

	// Live re-read shows the new title; the old one is gone.
	const collection = library.collection(/todos/i);
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
		library.collection(/todos/i).getByText("Draft the launch memo"),
	).toBeVisible({ timeout: 15_000 });
});

test("delete a seeded Person via the inline confirm → delete_person removes it", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const library = new LibraryPage(page, core.url);
	const PERSON = "01900000-0000-7000-8000-0000000000f1";
	seedEntities(dbPath, [
		{ id: PERSON, type: "person", data: { name: "Dana Holt" } },
	]);

	await library.gotoCollection("people", PERSON);
	const detail = library.rail(/Dana Holt details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Inline (non-modal) two-step delete confirm (ADR-0033, "approval is sacred").
	await library.deleteEntity(detail, "person");

	// Row is gone from the collection and the rail closed (route dropped ?id).
	const collection = library.collection(/people/i);
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
	const library = new LibraryPage(page, core.url);
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

	await library.gotoCollection("projects", PROJECT_MIGRATION);
	const detail = library.rail(/Retire the legacy API details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await library.deleteEntity(detail, "project");

	const collection = library.collection(/projects/i);
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
	const library = new LibraryPage(page, core.url);
	const PERSON = "01900000-0000-7000-8000-000000010001";
	seedEntities(dbPath, [
		{
			id: PERSON,
			type: "person",
			data: { name: "Sam Rivera", note: "Designer" },
		},
	]);

	await library.gotoCollection("people", PERSON);
	const detail = library.rail(/Sam Rivera details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await library.enterEdit(detail, "person");
	await library.fillField(detail, "Note", "Lead designer, design systems");
	await library.save(detail);

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
	const library = new LibraryPage(page, core.url);
	const PROJECT = "01900000-0000-7000-8000-000000010002";
	seedEntities(dbPath, [
		{
			id: PROJECT,
			type: "project",
			data: { name: "Spring launch", status: "active" },
		},
	]);

	await library.gotoCollection("projects", PROJECT);
	const detail = library.rail(/Spring launch details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await library.enterEdit(detail, "project");
	await library.selectField(detail, "Status", "on_hold");
	await library.save(detail);

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
	const library = new LibraryPage(page, core.url);
	const TODO = "01900000-0000-7000-8000-000000010003";
	seedEntities(dbPath, [
		{
			id: TODO,
			type: "todo",
			data: { title: "Cancel the old subscription", status: "active" },
		},
	]);

	await library.gotoCollection("todos", TODO);
	const detail = library.rail(/Cancel the old subscription details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await library.deleteEntity(detail, "todo");

	await expect(
		library.collection(/todos/i).getByText("Cancel the old subscription"),
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
	const library = new LibraryPage(page, core.url);
	const TODO = "01900000-0000-7000-8000-000000010007";
	seedEntities(dbPath, [
		{
			id: TODO,
			type: "todo",
			data: { title: "Keep this task", status: "active" },
		},
	]);

	await library.gotoCollection("todos", TODO);
	const detail = library.rail(/Keep this task details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Reveal the inline confirm, then back out — the shell resets `confirmingDelete`
	// (and `del.reset()`) so no `entity/mutate` is sent (ADR-0033, "approval is sacred").
	await library.deleteButton(detail, "todo").click();
	await expect(library.deleteConfirmPrompt(detail, "todo")).toBeVisible();
	await library.cancelDelete(detail);

	// Confirm dismissed, the delete affordance is back, the rail stayed open (?id kept).
	await expect(library.deleteConfirmPrompt(detail, "todo")).toHaveCount(0);
	await expect(library.deleteButton(detail, "todo")).toBeVisible();
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
	const library = new LibraryPage(page, core.url);
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

	await library.gotoCollection("journal", JE);
	const detail = library.rail(/Morning standup ran long. details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Edit: full-replace body via the JournalEntryEditor (ADR-0033 slice-8).
	await library.enterEdit(detail, "journal entry");
	const body = library.field(detail, "Body");
	await expect(body).toHaveValue("Morning standup ran long.");
	await body.fill("Morning standup ran long; agreed to timebox it.");
	await library.save(detail);

	const region = library.collection(/journal/i);
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
	await library.gotoCollection("journal", JE);
	const detail2 = library.rail(/details/i);
	await expect(detail2).toBeVisible({ timeout: 15_000 });
	await library.deleteEntity(detail2, "journal entry");

	await expect(
		library.collection(/journal/i).getByText(/Morning standup/),
	).toHaveCount(0, { timeout: 15_000 });
	expect(
		sqliteScalar(dbPath, `SELECT count(*) FROM entities WHERE id='${JE}';`),
	).toBe("0");
});

test("create a Media item via the rail editor → entity/mutate writes it and the row appears", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const library = new LibraryPage(page, core.url);

	// The Media topic is the static `/library/media` route; selection rides `?id`
	// on it (the KIND_META.media slug "media" collides with this route, so the rail
	// stays in-place rather than navigating to /library/$kind — ADR-0059).
	await library.gotoCollection("media");
	await library.newEntity("media");

	const rail = library.rail(/new media/i);
	await expect(rail).toBeVisible({ timeout: 15_000 });
	await library.fillField(rail, "Title", "The Pragmatic Programmer");
	await library.selectField(rail, "Medium", "book");
	await library.selectField(rail, "State", "consuming");
	await library.save(rail);

	// The new Media lands in the live collection.
	const collection = library.collection(/media/i);
	await expect(collection.getByText("The Pragmatic Programmer")).toBeVisible({
		timeout: 15_000,
	});

	// DB ground truth: exactly one Media row with that title, created_by the user,
	// carrying the chosen medium/state.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT count(*) FROM entities WHERE type='media' AND created_by='user' AND json_extract(data,'$.title')='The Pragmatic Programmer' AND json_extract(data,'$.medium')='book' AND json_extract(data,'$.state')='consuming';`,
		),
	).toBe("1");
});

test("edit a seeded Media item via the rail editor → update_media persists across reload", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const library = new LibraryPage(page, core.url);
	const MEDIA = "01900000-0000-7000-8000-000000010005";
	seedEntities(dbPath, [
		{
			id: MEDIA,
			type: "media",
			data: { title: "Dune", medium: "book", state: "backlog" },
		},
	]);

	await library.gotoCollection("media", MEDIA);
	const detail = library.rail(/Dune details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await library.enterEdit(detail, "media");
	const title = library.field(detail, "Title");
	await expect(title).toHaveValue("Dune");
	await title.fill("Dune Messiah");
	await library.save(detail);

	// Live re-read shows the new title; the old one is gone.
	const collection = library.collection(/media/i);
	await expect(collection.getByText("Dune Messiah")).toBeVisible({
		timeout: 15_000,
	});
	await expect(collection.getByText("Dune", { exact: true })).toHaveCount(0);

	// Persisted in Core (not just optimistic): the row's data carries the new title;
	// the full-replace kept medium/state.
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.title') FROM entities WHERE id='${MEDIA}';`,
		),
	).toBe("Dune Messiah");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.medium') FROM entities WHERE id='${MEDIA}';`,
		),
	).toBe("book");
	expect(
		sqliteScalar(
			dbPath,
			`SELECT json_extract(data,'$.state') FROM entities WHERE id='${MEDIA}';`,
		),
	).toBe("backlog");

	// Survives a reload (proves the write reached tier 2, not just the cache).
	await page.reload();
	await expect(
		library.collection(/media/i).getByText("Dune Messiah"),
	).toBeVisible({ timeout: 15_000 });
});

test("delete a seeded Media item via the inline confirm → delete_media removes it", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const library = new LibraryPage(page, core.url);
	const MEDIA = "01900000-0000-7000-8000-000000010006";
	seedEntities(dbPath, [
		{
			id: MEDIA,
			type: "media",
			data: { title: "Stale link", medium: "link", state: "done" },
		},
	]);

	await library.gotoCollection("media", MEDIA);
	const detail = library.rail(/Stale link details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	// Inline (non-modal) two-step delete confirm (ADR-0033, "approval is sacred").
	await library.deleteEntity(detail, "media");

	// Row is gone from the collection and the rail closed (route dropped ?id).
	const collection = library.collection(/media/i);
	await expect(collection.getByText("Stale link")).toHaveCount(0, {
		timeout: 15_000,
	});

	// DB ground truth: the Media row no longer exists.
	expect(
		sqliteScalar(dbPath, `SELECT count(*) FROM entities WHERE id='${MEDIA}';`),
	).toBe("0");
});

test("create a Todo shows the 'Created' success cue", async ({
	page,
	core,
}) => {
	const library = new LibraryPage(page, core.url);

	await library.gotoCollection("todos");
	await library.newEntity("todo");

	const rail = library.rail(/new todo/i);
	await expect(rail).toBeVisible({ timeout: 15_000 });
	await library.fillField(rail, "Title", "Order more coffee filters");
	await library.save(rail);

	// The success cue announces "Created" once the create round-trips through Core.
	await expect(library.successCue()).toContainText("Created", {
		timeout: 5_000,
	});
});

test("delete a seeded Todo shows the 'Deleted' success cue", async ({
	page,
	core,
	workspace,
}) => {
	const dbPath = dbPathFor(workspace.path);
	const library = new LibraryPage(page, core.url);
	const TODO = "01900000-0000-7000-8000-000000010008";
	seedEntities(dbPath, [
		{
			id: TODO,
			type: "todo",
			data: { title: "Toss the expired snacks", status: "active" },
		},
	]);

	await library.gotoCollection("todos", TODO);
	const detail = library.rail(/Toss the expired snacks details/i);
	await expect(detail).toBeVisible({ timeout: 15_000 });

	await library.deleteEntity(detail, "todo");

	// The delete navigates away (route drops ?id) and unmounts the editor, but the
	// cue is root-mounted so it survives (slice 2) — it announces "Deleted".
	await expect(library.successCue()).toContainText("Deleted", {
		timeout: 5_000,
	});

	// And the navigation the cue is meant to survive actually happened: the detail
	// rail is dismissed and ?id is cleared. Without this the test would still pass
	// if delete stopped clearing the route, masking a regression in the very
	// contract ("the cue survives navigation") it claims to prove.
	await expect(detail).toHaveCount(0, { timeout: 15_000 });
	await expect(page).toHaveURL(/\/library\/todos$/, { timeout: 15_000 });
});
