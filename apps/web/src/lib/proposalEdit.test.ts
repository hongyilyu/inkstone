import { describe, expect, it } from "vitest";
import {
	type CreateTodoDraft,
	overlayCreateTodo,
	seedCreateTodo,
} from "./proposalEdit.js";

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe("proposalEdit — create_todo", () => {
	describe("overlay", () => {
		const proposed = {
			todo: {
				title: "Email Alce about Project Y",
				note: "Send the migration plan.",
				status: "active",
				project_id: "proj-1",
				due_at: "2026-07-01T00:00:00",
				recurrence: { interval: 1, unit: "week" },
			},
			person_refs: [
				{ person_id: "alice-1", role: "related" },
				{ person_id: "bob-1", role: "waiting_on" },
			],
			source_journal_entry_id: "je-9",
		};

		it("editing title preserves person_refs, source_journal_entry_id, and unsurfaced todo fields", () => {
			const draft = seedCreateTodo(proposed);
			const edited = overlayCreateTodo(proposed, {
				...draft,
				title: "Email Alice about Project Y",
			});
			expect(edited).toEqual({
				todo: {
					title: "Email Alice about Project Y",
					note: "Send the migration plan.",
					status: "active",
					project_id: "proj-1",
					due_at: "2026-07-01T00:00:00",
					recurrence: { interval: 1, unit: "week" },
				},
				person_refs: [
					{ person_id: "alice-1", role: "related" },
					{ person_id: "bob-1", role: "waiting_on" },
				],
				source_journal_entry_id: "je-9",
			});
		});

		it("does not mutate the proposed payload (overlay clones)", () => {
			const draft = seedCreateTodo(proposed);
			overlayCreateTodo(proposed, { ...draft, title: "Changed" });
			expect(proposed.todo.title).toBe("Email Alce about Project Y");
		});

		describe("status↔timestamp coupling", () => {
			it("active→completed adds a valid completed_at and omits dropped_at", () => {
				const draft = seedCreateTodo(proposed);
				const edited = overlayCreateTodo(proposed, {
					...draft,
					status: "completed",
				}) as { todo: Record<string, unknown> };
				expect(edited.todo.status).toBe("completed");
				expect(edited.todo.completed_at).toMatch(LOCAL_DATETIME_RE);
				expect("dropped_at" in edited.todo).toBe(false);
			});

			it("active→dropped adds a valid dropped_at and omits completed_at", () => {
				const draft = seedCreateTodo(proposed);
				const edited = overlayCreateTodo(proposed, {
					...draft,
					status: "dropped",
				}) as { todo: Record<string, unknown> };
				expect(edited.todo.status).toBe("dropped");
				expect(edited.todo.dropped_at).toMatch(LOCAL_DATETIME_RE);
				expect("completed_at" in edited.todo).toBe(false);
			});

			it("→active clears both completed_at and dropped_at", () => {
				const completedProposed = {
					todo: {
						title: "Done thing",
						status: "completed",
						completed_at: "2026-06-01T09:00:00",
					},
				};
				const draft = seedCreateTodo(completedProposed);
				const edited = overlayCreateTodo(completedProposed, {
					...draft,
					status: "active",
				}) as { todo: Record<string, unknown> };
				expect(edited.todo.status).toBe("active");
				expect("completed_at" in edited.todo).toBe(false);
				expect("dropped_at" in edited.todo).toBe(false);
			});

			it("leaves a stored completed_at intact when status is unchanged", () => {
				const completedProposed = {
					todo: {
						title: "Done thing",
						status: "completed",
						completed_at: "2026-06-01T09:00:00",
					},
				};
				const draft = seedCreateTodo(completedProposed);
				const edited = overlayCreateTodo(completedProposed, {
					...draft,
					title: "Done thing edited",
				}) as { todo: Record<string, unknown> };
				expect(edited.todo.completed_at).toBe("2026-06-01T09:00:00");
			});
		});

		it("blanking the note omits the note key", () => {
			const draft = seedCreateTodo(proposed);
			const edited = overlayCreateTodo(proposed, {
				...draft,
				note: "",
			}) as { todo: Record<string, unknown> };
			expect("note" in edited.todo).toBe(false);
		});
	});

	describe("seed", () => {
		it("seeds title/note/status from a well-formed proposed todo", () => {
			const draft = seedCreateTodo({
				todo: { title: "T", note: "N", status: "completed" },
			});
			expect(draft).toEqual({
				title: "T",
				note: "N",
				status: "completed",
			} satisfies CreateTodoDraft);
		});

		it("seeds an empty draft from a null payload without throwing", () => {
			expect(seedCreateTodo(null)).toEqual({
				title: "",
				note: "",
				status: "active",
			});
		});

		it("seeds an empty draft from an empty object without throwing", () => {
			expect(seedCreateTodo({})).toEqual({
				title: "",
				note: "",
				status: "active",
			});
		});

		it("degrades a wrong-typed/partial todo without throwing", () => {
			expect(seedCreateTodo({ todo: { title: 42, status: "weird" } })).toEqual({
				title: "",
				note: "",
				status: "active",
			});
		});
	});
});
