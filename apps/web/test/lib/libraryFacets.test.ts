import { describe, expect, it } from "vitest";
import {
	composeFacets,
	deriveFacets,
	EMPTY_FACETS,
	facetCounts,
	facetsForKind,
	hasActiveFacets,
	isFacetActive,
	toggleFacet,
} from "@/lib/libraryFacets";
import type { LibraryItem, Media, Project } from "@/lib/libraryItems";

// The facet engine serves the two Library kinds that still carry facets: Project
// (a status axis) and Media (medium + state axes). Every axis is a multi-select
// Set — OR within an axis, AND across axes. Todo/GTD facets retired with the
// TickTick cutover.

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

function media(
	id: string,
	over: Partial<Media> & Pick<Media, "medium" | "state">,
): Media {
	return {
		id,
		kind: "media",
		createdAt: "2026-06-01T00:00:00",
		recency: 0,
		title: id,
		...over,
	};
}

const ids = (items: LibraryItem[]) => items.map((i) => i.id).sort();

describe("facetsForKind", () => {
	it("offers status for project, medium+state for media, none else", () => {
		expect(facetsForKind("project")).toEqual(["status"]);
		expect(facetsForKind("media")).toEqual(["medium", "state"]);
		expect(facetsForKind("person")).toEqual([]);
		expect(facetsForKind("journal_entry")).toEqual([]);
	});
});

// Four projects spanning distinct statuses so the status axis can partition.
const pr1 = project("pr1", { status: "active" });
const pr2 = project("pr2", { status: "on_hold" });
const pr3 = project("pr3", { status: "completed" });
const pr4 = project("pr4", { status: "dropped" });
const PROJECTS: LibraryItem[] = [pr1, pr2, pr3, pr4];

describe("project status facet", () => {
	it("narrows by a single status", () => {
		expect(
			ids(
				composeFacets(PROJECTS, {
					...EMPTY_FACETS,
					statuses: new Set(["active"]),
				}),
			),
		).toEqual(["pr1"]);
	});

	it("ORs within the status axis", () => {
		expect(
			ids(
				composeFacets(PROJECTS, {
					...EMPTY_FACETS,
					statuses: new Set(["active", "on_hold"]),
				}),
			),
		).toEqual(["pr1", "pr2"]);
	});

	it("derives a status group in canonical domain order, labelled", () => {
		const groups = deriveFacets("project", PROJECTS);
		expect(groups.map((g) => g.key)).toEqual(["status"]);
		expect(groups[0]?.label).toBe("Status");
		expect(groups[0]?.values.map((v) => v.value)).toEqual([
			"active",
			"on_hold",
			"completed",
			"dropped",
		]);
	});

	it("hides the status group when it cannot partition (<2 distinct values)", () => {
		const oneStatus = [
			project("a", { status: "active" }),
			project("b", { status: "active" }),
		];
		expect(deriveFacets("project", oneStatus)).toEqual([]);
	});

	it("counts statuses leave-one-out (ignores status's own selection)", () => {
		const counts = facetCounts("status", PROJECTS, {
			...EMPTY_FACETS,
			statuses: new Set(["active"]),
		});
		// Each status has exactly one project; the own-selection is ignored so the
		// other chips still show usable counts.
		expect(counts.get("active")).toBe(1);
		expect(counts.get("on_hold")).toBe(1);
		expect(counts.get("completed")).toBe(1);
	});
});

// Five media items spanning every medium and state bucket — the medium/state axes
// are multi-select Set axes sourced from `item.medium`/`item.state` and the
// MEDIA_MEDIUMS/MEDIA_STATES domains.
const m1 = media("m1", { medium: "book", state: "backlog" });
const m2 = media("m2", { medium: "book", state: "consuming" });
const m3 = media("m3", { medium: "movie", state: "backlog" });
const m4 = media("m4", { medium: "tv", state: "done" });
const m5 = media("m5", { medium: "article", state: "abandoned" });
const MEDIA: LibraryItem[] = [m1, m2, m3, m4, m5];

describe("media medium/state facets", () => {
	it("derives a medium group AND a state group in canonical domain order, labelled", () => {
		const groups = deriveFacets("media", MEDIA);
		const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
		expect(groups.map((g) => g.key)).toEqual(["medium", "state"]);
		expect(byKey.medium.label).toBe("Medium");
		expect(byKey.state.label).toBe("State");
		// Mediums follow MEDIA_MEDIUMS order ([link, article, book, tv, movie]),
		// filtered to those present; "link" is absent so it drops out.
		expect(byKey.medium.values.map((v) => v.value)).toEqual([
			"article",
			"book",
			"tv",
			"movie",
		]);
		expect(byKey.medium.values.map((v) => v.label)).toEqual([
			"Article",
			"Book",
			"TV",
			"Movie",
		]);
		// States follow MEDIA_STATES order ([backlog, consuming, done, abandoned]).
		expect(byKey.state.values.map((v) => v.value)).toEqual([
			"backlog",
			"consuming",
			"done",
			"abandoned",
		]);
		expect(byKey.state.values.map((v) => v.label)).toEqual([
			"Backlog",
			"Consuming",
			"Done",
			"Abandoned",
		]);
	});

	it("hides a media facet group that cannot partition (<2 distinct values)", () => {
		// All books, all in distinct states → medium has a single value (no group),
		// state still partitions.
		const allBooks = [
			media("b1", { medium: "book", state: "backlog" }),
			media("b2", { medium: "book", state: "done" }),
		];
		const groups = deriveFacets("media", allBooks);
		expect(groups.map((g) => g.key)).toEqual(["state"]);
	});

	it("narrows by medium (book) only", () => {
		const filtered = composeFacets(MEDIA, {
			...EMPTY_FACETS,
			mediums: new Set(["book"]),
		});
		expect(ids(filtered)).toEqual(["m1", "m2"]);
	});

	it("ANDs across the medium and state axes (book AND backlog)", () => {
		const filtered = composeFacets(MEDIA, {
			...EMPTY_FACETS,
			mediums: new Set(["book"]),
			states: new Set(["backlog"]),
		});
		// m1 is book+backlog; m2 is book but consuming; m3 is backlog but movie.
		expect(ids(filtered)).toEqual(["m1"]);
	});

	it("ORs within the medium axis (book OR movie)", () => {
		const filtered = composeFacets(MEDIA, {
			...EMPTY_FACETS,
			mediums: new Set(["book", "movie"]),
		});
		expect(ids(filtered)).toEqual(["m1", "m2", "m3"]);
	});

	it("ORs within the state axis (backlog OR done)", () => {
		const filtered = composeFacets(MEDIA, {
			...EMPTY_FACETS,
			states: new Set(["backlog", "done"]),
		});
		expect(ids(filtered)).toEqual(["m1", "m3", "m4"]);
	});

	it("counts mediums leave-one-out: ignores medium's own selection, honors state", () => {
		// medium=book selected AND state=backlog. The medium chips ignore medium's
		// own selection (so OR stays discoverable) but honor state=backlog.
		const counts = facetCounts("medium", MEDIA, {
			...EMPTY_FACETS,
			mediums: new Set(["book"]),
			states: new Set(["backlog"]),
		});
		// Backlog media: m1(book), m3(movie). Other mediums contribute nothing.
		expect(counts.get("book")).toBe(1); // m1 — still counted despite medium=book
		expect(counts.get("movie")).toBe(1); // m3 — the OR pivot stays visible
		expect(counts.get("tv") ?? 0).toBe(0);
		expect(counts.get("article") ?? 0).toBe(0);
	});

	it("toggles + reads the medium/state Set axes without mutating the input", () => {
		const a0 = EMPTY_FACETS;
		const a1 = toggleFacet(a0, "medium", "book");
		expect(isFacetActive(a1, "medium", "book")).toBe(true);
		expect(a0.mediums.size).toBe(0); // original untouched
		expect(hasActiveFacets(a1)).toBe(true);
		const a2 = toggleFacet(a1, "state", "backlog");
		expect(isFacetActive(a2, "state", "backlog")).toBe(true);
		// Re-toggling removes just that value.
		const a3 = toggleFacet(a2, "medium", "book");
		expect(isFacetActive(a3, "medium", "book")).toBe(false);
		expect(isFacetActive(a3, "state", "backlog")).toBe(true);
	});
});
