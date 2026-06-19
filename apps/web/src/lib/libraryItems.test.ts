import { describe, expect, it } from "vitest";
import { parseTodo } from "@/lib/entityCodec";
import {
	activeProjectItems,
	dueSoonTodos,
	formatDateTime,
	formatDay,
	groupJournalEntriesByDay,
	inboxTodos,
	type JournalEntry,
	type JournalEntryBodyNode,
	journalEntriesMentioning,
	journalEntryBodyText,
	libraryItemKindForSlug,
	libraryItemSubtitle,
	libraryItemTitle,
	type Person,
	PROJECT_STATUS_LABEL,
	type Project,
	peopleForProject,
	projectForTodo,
	projectProgress,
	projectsForPerson,
	projectsForReview,
	recentlyCapturedItems,
	recurrenceSummary,
	searchLibraryItems,
	type Todo,
	todosForPerson,
	todosForProject,
	waitingTodos,
} from "@/lib/libraryItems";
import { libraryFixtures as entities } from "@/lib/libraryItems.fixtures";

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

		expect(libraryItemSubtitle(byId("person_priya"))).toContain(
			"Owns the SDK examples",
		);
		expect(libraryItemSubtitle(byId("todo_backfill"))).toBe("Due 2026-06-12");
	});

	it("maps route slugs to kinds", () => {
		expect(libraryItemKindForSlug("people")).toBe("person");
		expect(libraryItemKindForSlug("projects")).toBe("project");
		expect(libraryItemKindForSlug("todos")).toBe("todo");
		expect(libraryItemKindForSlug("bookmarks")).toBe("bookmark");
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

		it("treats on_hold as in-focus, excludes completed and dropped", () => {
			const onHold = {
				...mkProject("p_hold", "Held"),
				status: "on_hold" as const,
			};
			const completed = {
				...mkProject("p_done", "Done"),
				status: "completed" as const,
			};
			const dropped = {
				...mkProject("p_dropped", "Dropped"),
				status: "dropped" as const,
			};
			const focus = activeProjectItems([onHold, completed, dropped]);
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
			const dropped = mkTodo("x", {
				status: "dropped",
				personRefs: [{ personId: "alice", role: "waiting_on" }],
			});
			expect(waitingTodos([done, dropped])).toEqual([]);
		});

		it("does not drop a deferred waiting todo (defer_at is availability only)", () => {
			const t = mkTodo("def", {
				deferAt: "2099-01-01T00:00:00",
				personRefs: [{ personId: "alice", role: "waiting_on" }],
			});
			expect(waitingTodos([t]).map((x) => x.id)).toEqual(["def"]);
		});
	});

	describe("projectsForReview (ADR-0031)", () => {
		const now = "2026-06-12T12:00:00";
		const mkReviewable = (
			id: string,
			status: Project["status"],
			nextReviewAt?: string,
		): Project => ({ ...mkProject(id, id), status, nextReviewAt });

		it("includes active and on_hold projects whose review is due", () => {
			const world = [
				mkReviewable("active_due", "active", "2026-06-10T20:00:00"),
				mkReviewable("hold_due", "on_hold", "2026-06-12T00:00:00"),
			];
			expect(
				projectsForReview(world, now)
					.map((p) => p.id)
					.sort(),
			).toEqual(["active_due", "hold_due"]);
		});

		it("excludes future, completed, and dropped projects", () => {
			const world = [
				mkReviewable("future", "active", "2026-06-30T20:00:00"),
				mkReviewable("done", "completed", "2026-06-01T20:00:00"),
				mkReviewable("dropped", "dropped", "2026-06-01T20:00:00"),
				mkReviewable("no_date", "active", undefined),
			];
			expect(projectsForReview(world, now)).toEqual([]);
		});

		it("orders most-overdue first", () => {
			const world = [
				mkReviewable("b", "active", "2026-06-11T20:00:00"),
				mkReviewable("a", "active", "2026-06-05T20:00:00"),
			];
			expect(projectsForReview(world, now).map((p) => p.id)).toEqual([
				"a",
				"b",
			]);
		});

		it("surfaces the mock's overdue projects", () => {
			// today = 2026-06-12; apiv2 (06-07) and garden (06-08) are overdue.
			const ids = projectsForReview(entities, now).map((p) => p.id);
			expect(ids).toContain("proj_apiv2");
			expect(ids).toContain("proj_garden");
			expect(ids).not.toContain("proj_inkstone"); // 06-21 future
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

	describe("journalEntriesMentioning (ADR-0031 'Mentioned in')", () => {
		const alice = mkPerson("alice", "Alice");
		const mentioning = (id: string, targetId: string, occurredAt: string) =>
			({
				id,
				kind: "journal_entry",
				occurredAt,
				body: [
					{ type: "text", text: "Saw " },
					{ type: "entity_ref", refId: `r-${id}`, targetEntityId: targetId },
				],
				recency: 1,
				createdAt: "fixture",
			}) satisfies JournalEntry;

		it("returns journal entries whose body references the target, newest occurred first", () => {
			const older = mentioning("je_old", "alice", "2026-06-01T09:00:00");
			const newer = mentioning("je_new", "alice", "2026-06-10T09:00:00");
			const other = mentioning("je_other", "bob", "2026-06-11T09:00:00");
			expect(
				journalEntriesMentioning([alice, older, newer, other], alice).map(
					(e) => e.id,
				),
			).toEqual(["je_new", "je_old"]);
		});

		it("returns nothing when no entry references the target", () => {
			expect(journalEntriesMentioning([alice], alice)).toEqual([]);
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

describe("recurrence (ADR-0037 read side)", () => {
	const todoRow = (data: Record<string, unknown>) => ({
		id: "t_rec",
		data: { title: "Water the plants", status: "active", ...data },
		created_at: 1,
	});

	describe("toLibraryTodo recurrence mapping", () => {
		it("maps a snake_case rule to the camelCase view model", () => {
			const todo = parseTodo(
				todoRow({
					defer_at: "2026-06-14T09:00:00",
					recurrence: {
						interval: 2,
						unit: "week",
						anchor: "defer_at",
						end: { after_count: 10 },
					},
				}),
			);
			expect(todo.recurrence).toEqual({
				interval: 2,
				unit: "week",
				anchor: "defer_at",
				end: { afterCount: 10 },
			});
		});

		it("maps an until end condition", () => {
			const todo = parseTodo(
				todoRow({
					due_at: "2026-06-30T17:00:00",
					recurrence: {
						interval: 1,
						unit: "month",
						anchor: "due_at",
						end: { until: "2027-01-01T00:00:00" },
					},
				}),
			);
			expect(todo.recurrence).toEqual({
				interval: 1,
				unit: "month",
				anchor: "due_at",
				end: { until: "2027-01-01T00:00:00" },
			});
		});

		it("leaves recurrence undefined when the Todo carries no rule", () => {
			expect(parseTodo(todoRow({})).recurrence).toBeUndefined();
		});

		it("ignores a partial rule missing required fields", () => {
			expect(
				parseTodo(todoRow({ recurrence: { interval: 2 } })).recurrence,
			).toBeUndefined();
		});
	});

	describe("recurrenceSummary", () => {
		const rule = (extra: Partial<Parameters<typeof recurrenceSummary>[0]>) => ({
			interval: 1,
			unit: "day" as const,
			anchor: "defer_at" as const,
			...extra,
		});

		it("summarises interval-1 rules per unit", () => {
			expect(recurrenceSummary(rule({ unit: "day" }))).toBe("Repeats daily");
			expect(recurrenceSummary(rule({ unit: "week" }))).toBe("Repeats weekly");
			expect(recurrenceSummary(rule({ unit: "month" }))).toBe(
				"Repeats monthly",
			);
			expect(recurrenceSummary(rule({ unit: "year" }))).toBe("Repeats yearly");
			expect(recurrenceSummary(rule({ unit: "hour" }))).toBe("Repeats hourly");
			expect(recurrenceSummary(rule({ unit: "minute" }))).toBe(
				"Repeats every minute",
			);
		});

		it("summarises interval-N rules", () => {
			expect(recurrenceSummary(rule({ interval: 2, unit: "day" }))).toBe(
				"Repeats every 2 days",
			);
			expect(recurrenceSummary(rule({ interval: 3, unit: "week" }))).toBe(
				"Repeats every 3 weeks",
			);
		});

		it("does not throw when an end condition is present", () => {
			expect(
				recurrenceSummary(rule({ unit: "week", end: { afterCount: 5 } })),
			).toBe("Repeats weekly");
		});
	});
});

describe("formatDateTime", () => {
	const s = "2026-06-19T14:30:00";

	it("drops the bare T separator", () => {
		expect(formatDateTime(s)).not.toContain("T");
	});

	it("drops the seconds", () => {
		expect(formatDateTime(s)).not.toContain(":00");
		expect(formatDateTime(s)).not.toMatch(/:\d{2}:\d{2}/);
	});

	it("includes the day, month, and the 14:30 time", () => {
		const out = formatDateTime(s);
		expect(out).toContain("19");
		// Derive the month name from the same locale the formatter uses, so this
		// holds on a non-en ICU runner (en-US "Jun", fr-FR "juin", de-DE "Juni").
		const month = new Date(s).toLocaleDateString(undefined, { month: "short" });
		expect(out).toContain(month);
		// 24h "14:30" or 12h "2:30" — assert the minutes regardless of locale hour.
		expect(out).toMatch(/(14|2):30/);
	});

	it("returns the input rather than 'Invalid Date' when unparseable", () => {
		expect(formatDateTime("not a date")).toBe("not a date");
		expect(formatDateTime("")).toBe("");
	});
});

describe("formatDay", () => {
	const s = "2026-06-19T14:30:00";

	it("returns a day-granularity string with no time", () => {
		const out = formatDay(s);
		expect(out).not.toContain("T");
		expect(out).not.toMatch(/\d{1,2}:\d{2}/);
		expect(out).toContain("19");
		// Month name derived from the same locale (see formatDateTime test above).
		const month = new Date(s).toLocaleDateString(undefined, { month: "short" });
		expect(out).toContain(month);
	});

	it("returns the input rather than 'Invalid Date' when unparseable", () => {
		expect(formatDay("not a date")).toBe("not a date");
		expect(formatDay("")).toBe("");
	});

	it("renders a bare date-only input on its own day (no timezone shift)", () => {
		// `new Date("2026-06-19")` parses as UTC midnight; in negative offsets that
		// renders the 18th. A date-only field must stay June 19 regardless of zone.
		const out = formatDay("2026-06-19");
		expect(out).toContain("19");
		// Month derived from the local-parts Date `formatDay` builds (not the
		// UTC-midnight string parse), so it matches on any ICU locale.
		const month = new Date(2026, 5, 19).toLocaleDateString(undefined, {
			month: "short",
		});
		expect(out).toContain(month);
		expect(out).not.toContain("18");
	});
});
