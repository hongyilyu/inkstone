import { libraryFixtures as entities } from "@test/lib/libraryItems.fixtures";
import { describe, expect, it } from "vitest";
import {
	activeProjectItems,
	addDays,
	formatDateTime,
	formatDay,
	groupJournalEntriesByDay,
	type JournalEntry,
	type JournalEntryBodyNode,
	journalEntryBodyText,
	libraryItemKindForSlug,
	libraryItemSubtitle,
	libraryItemTitle,
	type Person,
	PROJECT_STATUS_LABEL,
	type Project,
	projectsForReview,
	recentlyCapturedItems,
	searchLibraryItems,
	todayHubStats,
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

describe("library item helpers", () => {
	it("titles and subtitles read the right field per kind", () => {
		expect(libraryItemTitle(byId("person_priya"))).toBe("Priya Nair");
		expect(libraryItemTitle(byId("proj_apiv2"))).toBe("API v2 migration");

		expect(libraryItemSubtitle(byId("person_priya"))).toContain(
			"Owns the SDK examples",
		);
		expect(libraryItemSubtitle(byId("proj_apiv2"))).toContain(
			"Rename /contacts",
		);
	});

	it("maps route slugs to kinds", () => {
		expect(libraryItemKindForSlug("people")).toBe("person");
		expect(libraryItemKindForSlug("projects")).toBe("project");
		// The todos collection retired with the TickTick cutover — its slug no
		// longer resolves to a kind.
		expect(libraryItemKindForSlug("todos")).toBeUndefined();
		expect(libraryItemKindForSlug("media")).toBe("media");
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

	describe("todayHubStats (Today hub glance count, ADR-0054)", () => {
		// Fixed "now" so the review window is clock-independent (today =
		// 2026-06-12). Composes projectsForReview — tasks live in TickTick since
		// the S4 cutover, so the hub counts only reviewable projects.
		const now = new Date("2026-06-12T12:00:00");

		it("counts reviewable projects", () => {
			const reviewable: Project = {
				...mkProject("rev", "Reviewable"),
				nextReviewAt: "2026-06-10T00:00:00",
			};
			expect(
				todayHubStats([mkPerson("p", "Bystander"), reviewable], now),
			).toEqual({ toReview: 1 });
		});

		it("is zero for an empty workspace", () => {
			expect(todayHubStats([], now)).toEqual({ toReview: 0 });
		});

		it("counts only due/overdue reviews, not a future-scheduled one", () => {
			const overdue: Project = {
				...mkProject("overdue", "Overdue"),
				nextReviewAt: "2026-06-10T00:00:00",
			};
			const dueToday: Project = {
				...mkProject("today", "Due today"),
				nextReviewAt: "2026-06-12T00:00:00",
			};
			const future: Project = {
				...mkProject("future", "Future"),
				nextReviewAt: "2026-06-20T00:00:00",
			};
			expect(todayHubStats([overdue, dueToday, future], now).toReview).toBe(2);
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
		// Derive hour:minute from the same locale the formatter uses, so this holds
		// on a locale that pads the 12h hour (e.g. "02:30") or uses 24h ("14:30").
		const hm = new Date(s).toLocaleTimeString(undefined, {
			hour: "numeric",
			minute: "2-digit",
		});
		expect(out).toContain(hm);
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

describe("addDays", () => {
	// A fixed `now` keeps these clock-proof; the time-of-day is irrelevant since
	// addDays returns a bare day.
	const now = new Date("2026-06-25T10:00:00");

	it("returns tomorrow for n=1", () => {
		expect(addDays(1, now)).toBe("2026-06-26");
	});

	it("returns next week for n=7", () => {
		expect(addDays(7, now)).toBe("2026-07-02");
	});

	it("rolls over a month boundary", () => {
		expect(addDays(7, new Date("2026-06-28T10:00:00"))).toBe("2026-07-05");
	});

	it("rolls over a year boundary", () => {
		expect(addDays(7, new Date("2026-12-29T10:00:00"))).toBe("2027-01-05");
	});
});
