import { expect, test } from "./fixtures.js";
import { CommandPalette } from "./page-objects/CommandPalette.js";
import { dbPathFor, seedEntities, sqlite } from "./seed.js";

/**
 * Full-system Command Palette (⌘K, ADR-0024): the global navigation surface
 * mounted once in `__root`, reachable from every screen. It reads LIVE Core
 * data — recent Threads via `thread/list` and Library entities via
 * `entity/list` — groups the matches, and on activate navigates (a Thread
 * focuses the chat surface; an entity opens its Library detail rail).
 *
 * Previously covered only by a mock-transport unit test (CommandPalette.test.tsx);
 * this drives the real palette against a real Core through the DOM a user
 * touches. Distinctive seeded titles ("Zephyr…", "Quenby Marsh", "Operation
 * Foxglove") never collide with the mock preview rows, so each query resolves to
 * exactly the seeded match.
 *
 * Determinism: no Run is started; the default gate-fixture Worker never spawns.
 */

const THREAD_A = "01900000-0000-7000-8000-0000000a0001";
const THREAD_B = "01900000-0000-7000-8000-0000000a0002";
const PERSON = "01900000-0000-7000-8000-0000000a0003";
const PROJECT = "01900000-0000-7000-8000-0000000a0004";

const THREAD_A_TITLE = "Zephyr launch logistics";
const THREAD_B_TITLE = "Tax filing 2026";
const PERSON_NAME = "Quenby Marsh";
const PROJECT_NAME = "Operation Foxglove";

/** Seed two Threads (newest-activity first) plus a Person and a Project. */
function seedWorkspace(workspacePath: string): void {
	const dbPath = dbPathFor(workspacePath);
	const now = Date.now();
	sqlite(
		dbPath,
		`
		BEGIN IMMEDIATE;
		INSERT INTO threads (id, title, created_at, last_activity_at)
		VALUES ('${THREAD_A}', '${THREAD_A_TITLE}', ${now - 2000}, ${now});
		INSERT INTO threads (id, title, created_at, last_activity_at)
		VALUES ('${THREAD_B}', '${THREAD_B_TITLE}', ${now - 4000}, ${now - 3000});
		COMMIT;
		`,
	);
	seedEntities(dbPath, [
		{ id: PERSON, type: "person", data: { name: PERSON_NAME } },
		{
			id: PROJECT,
			type: "project",
			data: { name: PROJECT_NAME, status: "active" },
		},
	]);
}

test("opens via the ⌘K shortcut and via the sidebar Search button", async ({
	chat,
}) => {
	await chat.goto();
	const palette = new CommandPalette(chat.page);

	// Closed until invoked.
	await expect(palette.dialog()).toBeHidden();

	// Keyboard path.
	await palette.openWithKeyboard();
	await palette.close();

	// Sidebar button path opens the same palette.
	await chat
		.sidebar()
		.getByRole("button", { name: /search/i })
		.click();
	await expect(palette.dialog()).toBeVisible();
	await expect(palette.input()).toBeFocused();
});

test("filters live Threads and Library entities into grouped results", async ({
	chat,
	workspace,
}) => {
	seedWorkspace(workspace.path);
	await chat.goto();
	const palette = new CommandPalette(chat.page);
	await palette.openWithKeyboard();

	// A thread-only query: exactly the matching Thread, the other filtered out.
	await palette.search("Zephyr");
	await expect(palette.options()).toHaveCount(1);
	await expect(palette.option(THREAD_A_TITLE)).toBeVisible();
	await expect(palette.dialog().getByText(THREAD_B_TITLE)).toHaveCount(0);

	// A Person query resolves to the seeded live Person (live rows replace the
	// mock preview People, so it's the only People match).
	await palette.search("Quenby");
	await expect(palette.option(/Quenby Marsh/)).toBeVisible();

	// A Project query resolves to the seeded live Project.
	await palette.search("Foxglove");
	await expect(palette.option(/Operation Foxglove/)).toBeVisible();
});

test("teaches a no-match instead of going blank", async ({ chat }) => {
	await chat.goto();
	const palette = new CommandPalette(chat.page);
	await palette.openWithKeyboard();

	await palette.search("zzzznomatch");
	await expect(palette.options()).toHaveCount(0);
	await expect(palette.dialog().getByText(/no matches for/i)).toBeVisible();
});

test("keyboard Enter on a Thread result focuses it back on the chat surface", async ({
	chat,
	workspace,
}) => {
	seedWorkspace(workspace.path);
	await chat.goto();
	const palette = new CommandPalette(chat.page);
	await palette.openWithKeyboard();

	// Narrow to the one Thread, then activate the (auto-selected) first result.
	await palette.search("Zephyr");
	await expect(palette.option(THREAD_A_TITLE)).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await chat.page.keyboard.press("Enter");

	// The palette closes and the Thread is now the focused sidebar row.
	await expect(palette.dialog()).toBeHidden();
	await expect(
		chat.sidebar().getByRole("button", { name: THREAD_A_TITLE, exact: true }),
	).toHaveAttribute("aria-current", "true");
});

test("clicking a Library result opens its detail rail in the Library", async ({
	chat,
	page,
	workspace,
}) => {
	seedWorkspace(workspace.path);
	await chat.goto();
	const palette = new CommandPalette(chat.page);
	await palette.openWithKeyboard();

	await palette.search("Quenby");
	await palette.option(/Quenby Marsh/).click();

	// Navigated into the People collection with the entity selected, and its
	// detail rail (labelled "<title> details") mounted.
	await expect(page).toHaveURL(new RegExp(`/library/people\\?id=${PERSON}`));
	await expect(
		page.getByRole("complementary", { name: `${PERSON_NAME} details` }),
	).toBeVisible({ timeout: 15_000 });
});
