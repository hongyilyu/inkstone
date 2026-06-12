import { describe, expect, it } from "vitest";
import { entities } from "@/data/mock/entities";
import {
	activeProjectItems,
	dueSoonTodos,
	groupJournalEntriesByDay,
	inboxTodos,
	itemsNeedingReview,
	type JournalEntry,
	journalEntryBodyText,
	type JournalEntryBodyNode,
	libraryItemKindForSlug,
	libraryItemSubtitle,
	libraryItemTitle,
	type Person,
	type Project,
	PROJECT_STATUS_LABEL,
	peopleForProject,
	peopleForTodo,
	projectForTodo,
	projectProgress,
	projectsForPerson,
	recentlyCapturedItems,
	searchLibraryItems,
	type Todo,
	todosForPerson,
	todosForProject,
	waitingTodos,
} from "@/lib/libraryItems";

const byId = (id: string) => {
	const e = entities.find((x) => x.id === id);
	if (!e) throw new Error(`missing fixture ${id}`);
	return e;
};

const journalEntry = (
	id: string,
	occurredAt: string,
	body: string,
	recency: number,
): JournalEntry => ({
	id,
	kind: "journal_entry",
	occurredAt,
	body: [{ type: "text", text: body }],
	recency,
	createdAt: "fixture",
});

const mkPerson = (id: string, name: string): Person => ({
	id,
	kind: "person",
	name,
	recency: 1,
	createdAt: "fixture",
});

const mkProject = (id: string, name: string): Project => ({
	id,
	kind: "project",
	name,
	status: "active",
	recency: 1,
	createdAt: "fixture",
});

const mkTodo = (id: string, extra: Partial<Todo> = {}): Todo => ({
	id,
	kind: "todo",
	title: id,
	status: "active",
	personRefs: [],
	recency: 1,
	createdAt: "fixture",
	...extra,
});

describe("library item helpers", () => {
	it("titles and subtitles read the right field per kind", () => {
		expect(libraryItemTitle(byId("person_priya"))).toBe("Priya Nair");
		expect(libraryItemTitle(byId("proj_apiv2"))).toBe("API v2 migration");
		expect(libraryItemTitle(byId("todo_backfill"))).toContain("Backfill");

		expect(libraryItemSubtitle(byId("person_priya"))).toBe(
			"Staff engineer, Platform",
		);
		expect(libraryItemSubtitle(byId("todo_backfill"))).toBe("Due 2026-06-12");
	});

	it("maps route slugs to kinds", () => {
		expect(libraryItemKindForSlug("people")).toBe("person");
		expect(libraryItemKindForSlug("projects")).toBe("project");
		expect(libraryItemKindForSlug("todos")).toBe("todo");
		expect(libraryItemKindForSlug("recipes")).toBe("recipe");
		expect(libraryItemKindForSlug("nope")).toBeUndefined();
	});

	describe("searchLibraryItems", () => {
		it("ranks a title prefix match first", () => {
			const results = searchLibraryItems(entities, "priya");
			expect(results[0]?.id).toBe("person_priya");
		});

		it("returns recents (recency-sorted) for an empty query", () => {
			const results = searchLibraryItems(entities, "");
			expect(results).toHaveLength(8);
			const recencies = results.map((e) => e.recency);
			expect(recencies).toEqual([...recencies].sort((a, b) => b - a));
		});

		it("returns nothing for a non-match", () => {
			expect(searchLibraryItems(entities, "zzzznotathing")).toEqual([]);
		});
	});

	describe("dueSoonTodos", () => {
		// Fixed "now" so absolute due dates are clock-independent (today = 2026-06-12).
		const now = new Date("2026-06-12T12:00:00");
		const due = dueSoonTodos(entities, 3, now);

		it("includes only active todos due within the window, earliest first", () => {
			expect(due.map((t) => t.id)).toEqual([
				"todo_dentist", // 2026-06-11 overdue
				"todo_backfill", // 2026-06-12 today
				"todo_flights", // 2026-06-13
				"todo_schedule_alice", // 2026-06-14
				"todo_groceries", // 2026-06-15
			]);
		});

		it("excludes resolved todos and anything past the window", () => {
			expect(due.every((t) => t.status === "active")).toBe(true);
			expect(due.some((t) => t.id === "todo_estimate")).toBe(false); // 2026-06-19
			expect(due.some((t) => t.id === "todo_cutover")).toBe(false); // completed
		});
	});

	it("itemsNeedingReview returns only flagged items, newest first", () => {
		const review = itemsNeedingReview(entities);
		expect(review.every((e) => e.needsReview)).toBe(true);
		expect(review.map((e) => e.id).sort()).toEqual(
			[
				"person_alice",
				"person_priya",
				"recipe_sourdough",
				"todo_backfill",
			].sort(),
		);
	});

	it("recentlyCapturedItems honours the limit and recency order", () => {
		const recent = recentlyCapturedItems(entities, 3);
		expect(recent).toHaveLength(3);
		const recencies = recent.map((e) => e.recency);
		expect(recencies).toEqual([...recencies].sort((a, b) => b - a));
	});

	it("groups Journal Entries by occurred local day and sorts within each day by occurred time", () => {
		const groups = groupJournalEntriesByDay([
			journalEntry("late", "2026-06-10T18:30:00", "Late note", 40),
			journalEntry("newer-created", "2026-06-10T09:00:00", "Morning note", 90),
			journalEntry("next-day", "2026-06-11T08:00:00", "Next day", 10),
			journalEntry("previous-day", "2026-06-09T20:00:00", "Previous day", 99),
		]);

		expect(groups.map((group) => group.day)).toEqual([
			"2026-06-11",
			"2026-06-10",
			"2026-06-09",
		]);
		expect(groups[1]?.entries.map((entry) => entry.id)).toEqual([
			"newer-created",
			"late",
		]);
	});

	describe("project GTD vocabulary (ADR-0031)", () => {
		it("labels the GTD statuses, including on_hold", () => {
			expect(PROJECT_STATUS_LABEL).toEqual({
				active: "Active",
				on_hold: "On hold",
				completed: "Completed",
				dropped: "Dropped",
			});
		});

		it("subtitles a Project by its outcome", () => {
			expect(libraryItemSubtitle(byId("proj_apiv2"))).toContain(
				"Rename /contacts",
			);
		});

		it("treats on_hold as in-focus, excludes completed/dropped", () => {
			const onHold: Project = {
				id: "p_hold",
				kind: "project",
				name: "Held",
				status: "on_hold",
				recency: 5,
				createdAt: "fixture",
			};
			const completed: Project = {
				id: "p_done",
				kind: "project",
				name: "Done",
				status: "completed",
				recency: 4,
				createdAt: "fixture",
			};
			const focus = activeProjectItems([onHold, completed]);
			expect(focus.map((p) => p.id)).toEqual(["p_hold"]);
		});
	});

	describe("inboxTodos (ADR-0031)", () => {
		it("includes active todos with no project, due date, or person refs", () => {
			const t = mkTodo("inbox_me");
			expect(inboxTodos([t]).map((x) => x.id)).toEqual(["inbox_me"]);
		});

		it("excludes todos with a project, due date, or any person ref", () => {
			const withProject = mkTodo("p", { projectId: "proj" });
			const withDue = mkTodo("d", { dueAt: "2026-06-20T00:00:00" });
			const withRef = mkTodo("r", {
				personRefs: [{ personId: "x", role: "related" }],
			});
			expect(inboxTodos([withProject, withDue, withRef])).toEqual([]);
		});

		it("excludes completed and dropped todos", () => {
			const completed = mkTodo("c", { status: "completed" });
			const dropped = mkTodo("x", { status: "dropped" });
			expect(inboxTodos([completed, dropped])).toEqual([]);
		});

		it("keeps a todo that only has a defer date (still inbox)", () => {
			const deferred = mkTodo("def", { deferAt: "2026-07-01T00:00:00" });
			expect(inboxTodos([deferred]).map((x) => x.id)).toEqual(["def"]);
		});

		it("finds the mock's unorganized errands", () => {
			const ids = inboxTodos(entities).map((t) => t.id);
			expect(ids).toContain("todo_buy_milk");
			expect(ids).toContain("todo_read_handbook");
			// A todo with a project must not appear.
			expect(ids).not.toContain("todo_backfill");
		});
	});

	describe("waitingTodos (ADR-0031)", () => {
		it("includes active todos with a waiting_on ref", () => {
			const t = mkTodo("w", {
				personRefs: [{ personId: "alice", role: "waiting_on" }],
			});
			expect(waitingTodos([t]).map((x) => x.id)).toEqual(["w"]);
		});

		it("excludes todos whose only ref is related", () => {
			const t = mkTodo("r", {
				personRefs: [{ personId: "bob", role: "related" }],
			});
			expect(waitingTodos([t])).toEqual([]);
		});

		it("includes a todo with mixed refs as long as one is waiting_on", () => {
			const t = mkTodo("mix", {
				personRefs: [
					{ personId: "bob", role: "related" },
					{ personId: "alice", role: "waiting_on" },
				],
			});
			expect(waitingTodos([t]).map((x) => x.id)).toEqual(["mix"]);
		});

		it("excludes completed and dropped todos even when waiting_on", () => {
			const done = mkTodo("c", {
				status: "completed",
				personRefs: [{ personId: "alice", role: "waiting_on" }],
			});
			expect(waitingTodos([done])).toEqual([]);
		});

		it("does not drop a deferred waiting todo (defer_at is availability only)", () => {
			const t = mkTodo("def", {
				deferAt: "2099-01-01T00:00:00",
				personRefs: [{ personId: "alice", role: "waiting_on" }],
			});
			expect(waitingTodos([t]).map((x) => x.id)).toEqual(["def"]);
		});
	});

	it("computes project progress from its todos", () => {
		const apiv2 = byId("proj_apiv2") as Project;
		expect(projectProgress(entities, apiv2)).toEqual({ done: 1, total: 3 });
	});

	it("resolves project relations both directions", () => {
		const apiv2 = byId("proj_apiv2") as Project;
		expect(todosForProject(entities, apiv2)).toHaveLength(3);
		expect(peopleForProject(entities, apiv2).map((p) => p.id)).toEqual([
			"person_priya",
		]);
		const backfill = byId("todo_backfill") as Todo;
		expect(projectForTodo(entities, backfill)?.id).toBe("proj_apiv2");
	});

	describe("derives relations through person_refs (ADR-0031/0032)", () => {
		// Synthetic graph: alice waits on a todo in projA; bob is related on a
		// todo in projB. Project↔Person must derive ONLY through that project's
		// todos — bob must never leak into projA.
		const alice: Person = mkPerson("alice", "Alice");
		const bob: Person = mkPerson("bob", "Bob");
		const projA: Project = mkProject("projA", "Project A");
		const projB: Project = mkProject("projB", "Project B");
		const t1: Todo = mkTodo("t1", {
			projectId: "projA",
			personRefs: [{ personId: "alice", role: "waiting_on" }],
		});
		const t2: Todo = mkTodo("t2", {
			projectId: "projB",
			personRefs: [{ personId: "bob", role: "related" }],
		});
		const world = [alice, bob, projA, projB, t1, t2];

		it("peopleForProject derives only through that project's todos", () => {
			expect(peopleForProject(world, projA).map((p) => p.id)).toEqual([
				"alice",
			]);
			// bob is on projB's todo — must NOT appear under projA.
			expect(peopleForProject(world, projA).map((p) => p.id)).not.toContain(
				"bob",
			);
		});

		it("projectsForPerson derives through the person's todos", () => {
			expect(projectsForPerson(world, alice).map((p) => p.id)).toEqual([
				"projA",
			]);
			expect(projectsForPerson(world, bob).map((p) => p.id)).toEqual(["projB"]);
		});

		it("todosForPerson filters by role when asked", () => {
			expect(todosForPerson(world, alice).map((t) => t.id)).toEqual(["t1"]);
			expect(
				todosForPerson(world, alice, "waiting_on").map((t) => t.id),
			).toEqual(["t1"]);
			expect(todosForPerson(world, alice, "related")).toEqual([]);
		});

		it("peopleForTodo returns referenced people in ref order", () => {
			const t3 = mkTodo("t3", {
				personRefs: [
					{ personId: "bob", role: "related" },
					{ personId: "alice", role: "waiting_on" },
				],
			});
			expect(peopleForTodo([alice, bob, t3], t3).map((p) => p.id)).toEqual([
				"bob",
				"alice",
			]);
		});

		it("dedupes a person referenced by two of a project's todos", () => {
			const t1b = mkTodo("t1b", {
				projectId: "projA",
				personRefs: [{ personId: "alice", role: "related" }],
			});
			expect(
				peopleForProject([alice, projA, t1, t1b], projA).map((p) => p.id),
			).toEqual(["alice"]);
		});
	});

	it("renders Journal Entry body text from mixed nodes", () => {
		const body: JournalEntryBodyNode[] = [
			{ type: "text", text: "Met " },
			{
				type: "entity_ref",
				refId: "ref-1",
				targetTitle: "Ada Lovelace",
				labelSnapshot: "Ada",
			},
			{ type: "text", text: " at school." },
		];

		expect(journalEntryBodyText(body)).toBe("Met Ada Lovelace at school.");
		expect(
			journalEntryBodyText([
				{ type: "text", text: "Met " },
				{ type: "entity_ref", refId: "ref-2", labelSnapshot: "Ada" },
			]),
		).toBe("Met Ada");
	});

	it("does not resolve a relation target absent from the provided list", () => {
		const backfill = byId("todo_backfill") as Todo;
		expect(projectForTodo([backfill], backfill)).toBeUndefined();
	});
});
