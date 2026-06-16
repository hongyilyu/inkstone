import { describe, expect, it } from "vitest";
import {
	type CreatePersonDraft,
	type CreateProjectDraft,
	type CreateTodoDraft,
	overlayCreatePerson,
	overlayCreateProject,
	overlayCreateTodo,
	seedCreatePerson,
	seedCreateProject,
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

describe("proposalEdit — create_person", () => {
	const proposed = {
		name: "Alice Carter",
		note: "Met at the conference.",
		aliases: ["Ali", "AC"],
		source_journal_entry_id: "je-7",
	};

	describe("seed", () => {
		it("seeds name/note and joins proposed aliases back to a comma string", () => {
			expect(seedCreatePerson(proposed)).toEqual({
				name: "Alice Carter",
				note: "Met at the conference.",
				aliases: "Ali, AC",
			} satisfies CreatePersonDraft);
		});

		it("seeds an empty draft from a null payload without throwing", () => {
			expect(seedCreatePerson(null)).toEqual({
				name: "",
				note: "",
				aliases: "",
			});
		});

		it("degrades a non-array aliases to an empty string without throwing", () => {
			expect(seedCreatePerson({ name: "Bob", aliases: "Bobby" })).toEqual({
				name: "Bob",
				note: "",
				aliases: "",
			});
		});

		it("drops non-string aliases entries when joining", () => {
			expect(
				seedCreatePerson({ name: "Cara", aliases: ["C", 7, "Carrie"] }),
			).toEqual({
				name: "Cara",
				note: "",
				aliases: "C, Carrie",
			});
		});
	});

	describe("overlay", () => {
		it("editing name preserves source_journal_entry_id and unsurfaced fields", () => {
			const draft = seedCreatePerson(proposed);
			const edited = overlayCreatePerson(proposed, {
				...draft,
				name: "Alice C. Carter",
			});
			expect(edited).toEqual({
				name: "Alice C. Carter",
				note: "Met at the conference.",
				aliases: ["Ali", "AC"],
				source_journal_entry_id: "je-7",
			});
		});

		it("does not mutate the proposed payload (overlay clones)", () => {
			const draft = seedCreatePerson(proposed);
			overlayCreatePerson(proposed, { ...draft, name: "Changed" });
			expect(proposed.name).toBe("Alice Carter");
			expect(proposed.aliases).toEqual(["Ali", "AC"]);
		});

		it("splits the comma-separated aliases field to a trimmed non-empty array", () => {
			const edited = overlayCreatePerson(proposed, {
				name: "Alice",
				note: "",
				aliases: " Ali ,, AC , Allie ",
			}) as Record<string, unknown>;
			expect(edited.aliases).toEqual(["Ali", "AC", "Allie"]);
		});

		it("omits the aliases key when the field is blank", () => {
			const edited = overlayCreatePerson(proposed, {
				name: "Alice",
				note: "Met at the conference.",
				aliases: "   ",
			}) as Record<string, unknown>;
			expect("aliases" in edited).toBe(false);
		});

		it("omits the note key when the field is blank", () => {
			const edited = overlayCreatePerson(proposed, {
				name: "Alice",
				note: "",
				aliases: "Ali, AC",
			}) as Record<string, unknown>;
			expect("note" in edited).toBe(false);
		});
	});
});

describe("proposalEdit — create_project", () => {
	const proposed = {
		name: "Ship API v2 migration",
		outcome: "All clients on v2 by Q3.",
		note: "Coordinate with the platform team.",
		status: "active",
		review_every: { interval: 1, unit: "week" },
		next_review_at: "2026-07-01T09:00:00",
		last_reviewed_at: "2026-06-01T09:00:00",
		due_at: "2026-09-30T00:00:00",
		source_journal_entry_id: "je-9",
	};

	describe("seed", () => {
		it("seeds name/outcome/note/status from a well-formed proposed project", () => {
			expect(
				seedCreateProject({
					name: "P",
					outcome: "O",
					note: "N",
					status: "on_hold",
				}),
			).toEqual({
				name: "P",
				outcome: "O",
				note: "N",
				status: "on_hold",
			} satisfies CreateProjectDraft);
		});

		it("seeds an empty draft from a null payload without throwing", () => {
			expect(seedCreateProject(null)).toEqual({
				name: "",
				outcome: "",
				note: "",
				status: "active",
			});
		});

		it("degrades a wrong/unknown status to active", () => {
			expect(seedCreateProject({ name: "P", status: "weird" }).status).toBe(
				"active",
			);
		});
	});

	describe("overlay", () => {
		it("editing name preserves provenance, review cadence, and dates", () => {
			const draft = seedCreateProject(proposed);
			const edited = overlayCreateProject(proposed, {
				...draft,
				name: "Ship API v2",
			});
			expect(edited).toEqual({
				name: "Ship API v2",
				outcome: "All clients on v2 by Q3.",
				note: "Coordinate with the platform team.",
				status: "active",
				review_every: { interval: 1, unit: "week" },
				next_review_at: "2026-07-01T09:00:00",
				last_reviewed_at: "2026-06-01T09:00:00",
				due_at: "2026-09-30T00:00:00",
				source_journal_entry_id: "je-9",
			});
		});

		describe("status↔timestamp coupling", () => {
			it("active→completed adds a valid completed_at and omits dropped_at", () => {
				const draft = seedCreateProject(proposed);
				const edited = overlayCreateProject(proposed, {
					...draft,
					status: "completed",
				}) as Record<string, unknown>;
				expect(edited.status).toBe("completed");
				expect(edited.completed_at).toMatch(LOCAL_DATETIME_RE);
				expect("dropped_at" in edited).toBe(false);
			});

			it("active→dropped adds a valid dropped_at and omits completed_at", () => {
				const draft = seedCreateProject(proposed);
				const edited = overlayCreateProject(proposed, {
					...draft,
					status: "dropped",
				}) as Record<string, unknown>;
				expect(edited.status).toBe("dropped");
				expect(edited.dropped_at).toMatch(LOCAL_DATETIME_RE);
				expect("completed_at" in edited).toBe(false);
			});

			it("→on_hold clears both completed_at and dropped_at", () => {
				const completedProposed = {
					name: "Done project",
					status: "completed",
					completed_at: "2026-06-01T09:00:00",
				};
				const draft = seedCreateProject(completedProposed);
				const edited = overlayCreateProject(completedProposed, {
					...draft,
					status: "on_hold",
				}) as Record<string, unknown>;
				expect(edited.status).toBe("on_hold");
				expect("completed_at" in edited).toBe(false);
				expect("dropped_at" in edited).toBe(false);
			});

			it("→active clears both completed_at and dropped_at", () => {
				const droppedProposed = {
					name: "Abandoned project",
					status: "dropped",
					dropped_at: "2026-06-01T09:00:00",
				};
				const draft = seedCreateProject(droppedProposed);
				const edited = overlayCreateProject(droppedProposed, {
					...draft,
					status: "active",
				}) as Record<string, unknown>;
				expect(edited.status).toBe("active");
				expect("completed_at" in edited).toBe(false);
				expect("dropped_at" in edited).toBe(false);
			});

			it("leaves a stored completed_at intact when status is unchanged", () => {
				const completedProposed = {
					name: "Done project",
					status: "completed",
					completed_at: "2026-06-01T09:00:00",
				};
				const draft = seedCreateProject(completedProposed);
				const edited = overlayCreateProject(completedProposed, {
					...draft,
					name: "Done project edited",
				}) as Record<string, unknown>;
				expect(edited.completed_at).toBe("2026-06-01T09:00:00");
			});
		});

		it("omits blank outcome and note keys", () => {
			const draft = seedCreateProject(proposed);
			const edited = overlayCreateProject(proposed, {
				...draft,
				outcome: "",
				note: "",
			}) as Record<string, unknown>;
			expect("outcome" in edited).toBe(false);
			expect("note" in edited).toBe(false);
		});

		it("does not mutate the proposed payload (overlay clones)", () => {
			const draft = seedCreateProject(proposed);
			overlayCreateProject(proposed, { ...draft, name: "Changed" });
			expect(proposed.name).toBe("Ship API v2 migration");
		});
	});
});
