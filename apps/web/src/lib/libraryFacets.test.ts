import { describe, expect, it } from "vitest";
import {
	composeFacets,
	dateBucket,
	deriveFacets,
	EMPTY_FACETS,
	facetCounts,
	facetsForKind,
	hasActiveFacets,
	isFacetActive,
	toggleFacet,
} from "./libraryFacets";
import type { LibraryItem, Person, Project, Todo } from "./libraryItems";

// A fixed "today" so the date-bucket math is deterministic: 2026-06-15.
// Horizon for "Due soon" is +7 days → 2026-06-22.
const NOW = new Date(2026, 5, 15);

function todo(id: string, over: Partial<Todo> & Pick<Todo, "status">): Todo {
	return {
		id,
		kind: "todo",
		createdAt: "2026-06-01T00:00:00",
		recency: 0,
		title: id,
		personRefs: [],
		...over,
	};
}

function person(id: string, name: string): Person {
	return {
		id,
		kind: "person",
		createdAt: "2026-06-01T00:00:00",
		recency: 0,
		name,
	};
}

function project(
	id: string,
	over: Partial<Project> & Pick<Project, "status">,
): Project {
	return {
		id,
		kind: "project",
		createdAt: "2026-06-01T00:00:00",
		recency: 0,
		name: id,
		...over,
	};
}

const ada = person("p1", "Ada");
const grace = person("p2", "Grace");

// Five todos spanning every status and date bucket.
const t1 = todo("t1", {
	status: "active",
	dueAt: "2026-06-10T00:00:00", // < today → overdue
	personRefs: [{ personId: "p1", role: "related" }],
});
const t2 = todo("t2", {
	status: "active",
	dueAt: "2026-06-18T00:00:00", // within [today, today+7] → due_soon
	personRefs: [{ personId: "p2", role: "waiting_on" }],
});
const t3 = todo("t3", {
	status: "completed",
	dueAt: "2026-06-12T00:00:00", // < today → overdue, regardless of status
});
const t4 = todo("t4", { status: "active" }); // no dueAt → no_date
const t5 = todo("t5", {
	status: "dropped",
	dueAt: "2026-07-30T00:00:00", // beyond horizon → no bucket
	personRefs: [{ personId: "p1", role: "related" }],
});

const TODOS: LibraryItem[] = [t1, t2, t3, t4, t5];
const ALL: LibraryItem[] = [...TODOS, ada, grace];

const ids = (items: LibraryItem[]) => items.map((i) => i.id).sort();

describe("facetsForKind", () => {
	it("offers status+date+person for todo, status+person for project, none else", () => {
		expect(facetsForKind("todo")).toEqual(["status", "date", "person"]);
		expect(facetsForKind("project")).toEqual(["status", "person"]);
		expect(facetsForKind("person")).toEqual([]);
		expect(facetsForKind("journal_entry")).toEqual([]);
		expect(facetsForKind("bookmark")).toEqual([]);
	});
});

describe("dateBucket", () => {
	it("buckets a todo's due date purely by date, independent of status", () => {
		expect(dateBucket(t1, NOW)).toBe("overdue");
		expect(dateBucket(t3, NOW)).toBe("overdue"); // completed but still overdue
		expect(dateBucket(t2, NOW)).toBe("due_soon");
		expect(dateBucket(t4, NOW)).toBe("no_date");
		expect(dateBucket(t5, NOW)).toBeNull(); // dated beyond the soon horizon
	});

	it("treats the horizon edges as inclusive (today and today+7 are due_soon, +8 is null)", () => {
		const dueOn = (day: string) =>
			todo(`d-${day}`, { status: "active", dueAt: `${day}T00:00:00` });
		// today (2026-06-15) is not overdue (not < today) and within the window → due_soon.
		expect(dateBucket(dueOn("2026-06-15"), NOW)).toBe("due_soon");
		// today+7 (2026-06-22) is the inclusive upper edge → still due_soon.
		expect(dateBucket(dueOn("2026-06-22"), NOW)).toBe("due_soon");
		// today+8 (2026-06-23) falls past the horizon → no bucket.
		expect(dateBucket(dueOn("2026-06-23"), NOW)).toBeNull();
		// yesterday (2026-06-14) is strictly before today → overdue.
		expect(dateBucket(dueOn("2026-06-14"), NOW)).toBe("overdue");
	});
});

describe("composeFacets", () => {
	it("returns the base unchanged (and in order) when no facet is active", () => {
		expect(composeFacets(TODOS, EMPTY_FACETS, ALL, NOW)).toEqual(TODOS);
	});

	it("narrows by status with OR within the facet", () => {
		const oneStatus = composeFacets(
			TODOS,
			{ ...EMPTY_FACETS, statuses: new Set(["active"]) },
			ALL,
			NOW,
		);
		expect(ids(oneStatus)).toEqual(["t1", "t2", "t4"]);

		const twoStatuses = composeFacets(
			TODOS,
			{ ...EMPTY_FACETS, statuses: new Set(["active", "completed"]) },
			ALL,
			NOW,
		);
		expect(ids(twoStatuses)).toEqual(["t1", "t2", "t3", "t4"]); // excludes dropped t5
	});

	it("narrows by a single-select date preset", () => {
		expect(
			ids(composeFacets(TODOS, { ...EMPTY_FACETS, date: "overdue" }, ALL, NOW)),
		).toEqual(["t1", "t3"]);
		expect(
			ids(
				composeFacets(TODOS, { ...EMPTY_FACETS, date: "due_soon" }, ALL, NOW),
			),
		).toEqual(["t2"]);
		expect(
			ids(composeFacets(TODOS, { ...EMPTY_FACETS, date: "no_date" }, ALL, NOW)),
		).toEqual(["t4"]);
	});

	it("ANDs across facet types (status AND date)", () => {
		const both = composeFacets(
			TODOS,
			{ ...EMPTY_FACETS, statuses: new Set(["active"]), date: "overdue" },
			ALL,
			NOW,
		);
		// t1 is active+overdue; t3 is overdue but completed → excluded.
		expect(ids(both)).toEqual(["t1"]);
	});

	it("narrows by associated person with OR within the facet", () => {
		expect(
			ids(
				composeFacets(
					TODOS,
					{ ...EMPTY_FACETS, people: new Set(["p1"]) },
					ALL,
					NOW,
				),
			),
		).toEqual(["t1", "t5"]);
		expect(
			ids(
				composeFacets(
					TODOS,
					{ ...EMPTY_FACETS, people: new Set(["p1", "p2"]) },
					ALL,
					NOW,
				),
			),
		).toEqual(["t1", "t2", "t5"]);
	});

	it("narrows projects by people derived through their todos", () => {
		const pr1 = project("pr1", { status: "active" });
		const pr2 = project("pr2", { status: "completed" });
		const tp1 = todo("tp1", {
			status: "active",
			projectId: "pr1",
			personRefs: [{ personId: "p1", role: "related" }],
		});
		const tp2 = todo("tp2", {
			status: "active",
			projectId: "pr2",
			personRefs: [{ personId: "p2", role: "related" }],
		});
		const all = [pr1, pr2, tp1, tp2, ada, grace];
		const filtered = composeFacets(
			[pr1, pr2],
			{ ...EMPTY_FACETS, people: new Set(["p1"]) },
			all,
			NOW,
		);
		expect(ids(filtered)).toEqual(["pr1"]);
	});
});

describe("facetCounts (leave-one-out)", () => {
	it("counts a facet's own siblings ignoring that facet's selection", () => {
		// Status=active selected. Its OWN siblings ignore the status filter, so
		// 'completed' and 'dropped' keep their real counts (OR stays discoverable).
		const counts = facetCounts(
			"status",
			TODOS,
			{ ...EMPTY_FACETS, statuses: new Set(["active"]) },
			ALL,
			NOW,
		);
		expect(counts.get("active")).toBe(3); // t1,t2,t4
		expect(counts.get("completed")).toBe(1); // t3
		expect(counts.get("dropped")).toBe(1); // t5
	});

	it("honors OTHER active facets when counting (context-aware)", () => {
		// Date=overdue active → only t1,t3 survive the other-facet pass; group by status.
		const counts = facetCounts(
			"status",
			TODOS,
			{ ...EMPTY_FACETS, date: "overdue" },
			ALL,
			NOW,
		);
		expect(counts.get("active")).toBe(1); // t1
		expect(counts.get("completed")).toBe(1); // t3
		expect(counts.get("dropped") ?? 0).toBe(0); // none overdue
	});

	it("ignores the date facet's own selection when counting its buckets, but honors other facets", () => {
		// Date=overdue selected. Its OWN buckets ignore the date filter (so the user
		// can pivot to another preset), while the active status facet IS honored.
		const counts = facetCounts(
			"date",
			TODOS,
			{ ...EMPTY_FACETS, date: "overdue", statuses: new Set(["active"]) },
			ALL,
			NOW,
		);
		// Among active todos only: t1 overdue, t2 due_soon, t4 no_date (t3 completed, t5 dropped excluded).
		expect(counts.get("overdue")).toBe(1); // t1 — still counted despite date=overdue
		expect(counts.get("due_soon")).toBe(1); // t2 — the pivot target stays visible
		expect(counts.get("no_date")).toBe(1); // t4
	});

	it("yields all-zero person counts when another facet excludes every linked row", () => {
		// Status=completed → only t3 survives; t3 has no personRefs → no person has a count.
		const counts = facetCounts(
			"person",
			TODOS,
			{ ...EMPTY_FACETS, statuses: new Set(["completed"]) },
			ALL,
			NOW,
		);
		expect(counts.get("p1") ?? 0).toBe(0);
		expect(counts.get("p2") ?? 0).toBe(0);
	});
});

describe("toggleFacet / isFacetActive / hasActiveFacets", () => {
	it("multi-selects status (OR) without mutating the input", () => {
		const a0 = EMPTY_FACETS;
		const a1 = toggleFacet(a0, "status", "active");
		expect(isFacetActive(a1, "status", "active")).toBe(true);
		expect(a0.statuses.size).toBe(0); // original untouched
		const a2 = toggleFacet(a1, "status", "completed");
		expect([...a2.statuses].sort()).toEqual(["active", "completed"]);
		// Re-toggling removes just that value.
		const a3 = toggleFacet(a2, "status", "active");
		expect([...a3.statuses]).toEqual(["completed"]);
	});

	it("single-selects date: a second preset replaces the first; re-selecting clears", () => {
		const a1 = toggleFacet(EMPTY_FACETS, "date", "overdue");
		expect(a1.date).toBe("overdue");
		const a2 = toggleFacet(a1, "date", "due_soon");
		expect(a2.date).toBe("due_soon"); // replaced, not added
		const a3 = toggleFacet(a2, "date", "due_soon");
		expect(a3.date).toBeNull(); // re-select clears
	});

	it("reports whether anything is active", () => {
		expect(hasActiveFacets(EMPTY_FACETS)).toBe(false);
		expect(hasActiveFacets(toggleFacet(EMPTY_FACETS, "person", "p1"))).toBe(
			true,
		);
		expect(hasActiveFacets(toggleFacet(EMPTY_FACETS, "date", "overdue"))).toBe(
			true,
		);
	});
});

describe("deriveFacets", () => {
	it("derives the present-value groups for a todo collection", () => {
		const groups = deriveFacets("todo", TODOS, ALL, NOW);
		const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
		expect(groups.map((g) => g.key)).toEqual(["status", "date", "person"]);
		// Status values follow the canonical domain order, labelled.
		expect(byKey.status.values.map((v) => v.value)).toEqual([
			"active",
			"completed",
			"dropped",
		]);
		// Date presets in fixed order; t5's beyond-horizon date contributes no bucket.
		expect(byKey.date.values.map((v) => v.value)).toEqual([
			"overdue",
			"due_soon",
			"no_date",
		]);
		// People resolved to names; both present.
		expect(byKey.person.values.map((v) => v.label).sort()).toEqual([
			"Ada",
			"Grace",
		]);
	});

	it("hides a facet group that cannot partition (fewer than 2 distinct values)", () => {
		const allActive = [
			todo("a1", { status: "active" }),
			todo("a2", { status: "active" }),
		];
		const groups = deriveFacets("todo", allActive, allActive, NOW);
		// Only one status, no dates, no people → no group can partition.
		expect(groups).toEqual([]);
	});

	it("falls back to the raw id when a referenced person has no matching row", () => {
		// An orphan personId (no Person row in allItems) labels as the id itself,
		// rather than dropping the chip.
		const orphanTodo = todo("orphan", {
			status: "active",
			personRefs: [{ personId: "ghost", role: "related" }],
		});
		const withOrphan = [t1, orphanTodo]; // t1→Ada (real), orphan→"ghost" (no row)
		const groups = deriveFacets("todo", withOrphan, [ada, ...withOrphan], NOW);
		const personGroup = groups.find((g) => g.key === "person");
		expect(personGroup?.values.map((v) => v.label).sort()).toEqual([
			"Ada",
			"ghost",
		]);
	});

	it("offers no facets for kinds without them", () => {
		expect(deriveFacets("person", [ada, grace], ALL, NOW)).toEqual([]);
		expect(deriveFacets("bookmark", [], ALL, NOW)).toEqual([]);
	});

	it("derives status + person (no date) for a project collection", () => {
		const pr1 = project("pr1", { status: "active" });
		const pr2 = project("pr2", { status: "completed" });
		const tp1 = todo("tp1", {
			status: "active",
			projectId: "pr1",
			personRefs: [{ personId: "p1", role: "related" }],
		});
		const tp2 = todo("tp2", {
			status: "active",
			projectId: "pr2",
			personRefs: [{ personId: "p2", role: "related" }],
		});
		const all = [pr1, pr2, tp1, tp2, ada, grace];
		const groups = deriveFacets("project", [pr1, pr2], all, NOW);
		expect(groups.map((g) => g.key)).toEqual(["status", "person"]);
	});
});
