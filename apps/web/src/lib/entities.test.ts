import { describe, expect, it } from "vitest";
import { entities, type Project, type Todo } from "@/data/mock/entities";
import {
	dueSoon,
	entitySubtitle,
	entityTitle,
	kindForSlug,
	needsReview,
	peopleForProject,
	projectForTodo,
	projectProgress,
	recentlyCaptured,
	searchEntities,
	todosForProject,
} from "@/lib/entities";

const byId = (id: string) => {
	const e = entities.find((x) => x.id === id);
	if (!e) throw new Error(`missing fixture ${id}`);
	return e;
};

describe("entity helpers", () => {
	it("titles and subtitles read the right field per kind", () => {
		expect(entityTitle(byId("person_priya"))).toBe("Priya Nair");
		expect(entityTitle(byId("proj_apiv2"))).toBe("API v2 migration");
		expect(entityTitle(byId("todo_backfill"))).toContain("Backfill");

		expect(entitySubtitle(byId("person_priya"))).toBe(
			"Staff engineer, Platform",
		);
		expect(entitySubtitle(byId("todo_backfill"))).toBe("Due Today");
	});

	it("maps route slugs to kinds", () => {
		expect(kindForSlug("people")).toBe("person");
		expect(kindForSlug("projects")).toBe("project");
		expect(kindForSlug("todos")).toBe("todo");
		expect(kindForSlug("recipes")).toBe("recipe");
		expect(kindForSlug("nope")).toBeUndefined();
	});

	describe("searchEntities", () => {
		it("ranks a title prefix match first", () => {
			const results = searchEntities(entities, "priya");
			expect(results[0]?.id).toBe("person_priya");
		});

		it("returns recents (recency-sorted) for an empty query", () => {
			const results = searchEntities(entities, "");
			expect(results).toHaveLength(8);
			const recencies = results.map((e) => e.recency);
			expect(recencies).toEqual([...recencies].sort((a, b) => b - a));
		});

		it("returns nothing for a non-match", () => {
			expect(searchEntities(entities, "zzzznotathing")).toEqual([]);
		});
	});

	describe("dueSoon", () => {
		const due = dueSoon(entities);

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

	it("needsReview returns only flagged entities, newest first", () => {
		const review = needsReview(entities);
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

	it("recentlyCaptured honours the limit and recency order", () => {
		const recent = recentlyCaptured(entities, 3);
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
});
