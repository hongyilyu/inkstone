import { describe, expect, it } from "vitest";
import { entities } from "@/data/mock/entities";
import {
	dueSoonTodos,
	itemsNeedingReview,
	libraryItemKindForSlug,
	libraryItemSubtitle,
	libraryItemTitle,
	type Project,
	peopleForProject,
	projectForTodo,
	projectProgress,
	recentlyCapturedItems,
	searchLibraryItems,
	type Todo,
	todosForProject,
} from "@/lib/libraryItems";

const byId = (id: string) => {
	const e = entities.find((x) => x.id === id);
	if (!e) throw new Error(`missing fixture ${id}`);
	return e;
};

describe("library item helpers", () => {
	it("titles and subtitles read the right field per kind", () => {
		expect(libraryItemTitle(byId("person_priya"))).toBe("Priya Nair");
		expect(libraryItemTitle(byId("proj_apiv2"))).toBe("API v2 migration");
		expect(libraryItemTitle(byId("todo_backfill"))).toContain("Backfill");

		expect(libraryItemSubtitle(byId("person_priya"))).toBe(
			"Staff engineer, Platform",
		);
		expect(libraryItemSubtitle(byId("todo_backfill"))).toBe("Due Today");
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
		const due = dueSoonTodos(entities);

		it("includes only open todos due within the window, overdue first", () => {
			expect(due.map((t) => t.id)).toEqual([
				"todo_dentist", // -1 overdue
				"todo_backfill", // 0
				"todo_flights", // 1
				"todo_schedule_alice", // 2
				"todo_groceries", // 3
			]);
		});

		it("excludes done todos and anything past the window", () => {
			expect(due.every((t) => !t.done)).toBe(true);
			expect(due.some((t) => t.id === "todo_estimate")).toBe(false); // dueInDays 7
			expect(due.some((t) => t.id === "todo_cutover")).toBe(false); // done
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

	it("does not resolve a relation target absent from the provided list", () => {
		const backfill = byId("todo_backfill") as Todo;
		expect(projectForTodo([backfill], backfill)).toBeUndefined();
	});
});
