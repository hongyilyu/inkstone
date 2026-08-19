import { describe, expect, it } from "vitest";
import {
	type CreatePersonDraft,
	type CreateProjectDraft,
	overlayCreatePerson,
	overlayCreateProject,
	seedCreatePerson,
	seedCreateProject,
} from "@/lib/proposalEdit.js";

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

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
			});
			expect(edited.aliases).toEqual(["Ali", "AC", "Allie"]);
		});

		it("omits the aliases key when the field is blank", () => {
			const edited = overlayCreatePerson(proposed, {
				name: "Alice",
				note: "Met at the conference.",
				aliases: "   ",
			});
			expect("aliases" in edited).toBe(false);
		});

		it("omits the note key when the field is blank", () => {
			const edited = overlayCreatePerson(proposed, {
				name: "Alice",
				note: "",
				aliases: "Ali, AC",
			});
			expect("note" in edited).toBe(false);
		});

		// update_person rides this same create overlay (FULL-DOCUMENT REPLACE): the
		// proposed payload carries a top-level `entity_id` routing key, and clonePayload
		// must ride it through untouched while only the surfaced fields change.
		describe("full-replace update path (proposed carries a top-level entity_id)", () => {
			const updateProposed = {
				entity_id: "person-7",
				name: "Alice Carter",
				note: "Met at the conference.",
				aliases: ["Ali", "AC"],
			};

			it("preserves a top-level entity_id and unsurfaced fields when editing name", () => {
				const draft = seedCreatePerson(updateProposed);
				const edited = overlayCreatePerson(updateProposed, {
					...draft,
					name: "Alice C. Carter",
				});
				expect(edited).toEqual({
					entity_id: "person-7",
					name: "Alice C. Carter",
					note: "Met at the conference.",
					aliases: ["Ali", "AC"],
				});
			});

			it("blanking note/aliases under full replace still rides the entity_id through", () => {
				const edited = overlayCreatePerson(updateProposed, {
					name: "Alice",
					note: "",
					aliases: "   ",
				});
				expect("note" in edited).toBe(false);
				expect("aliases" in edited).toBe(false);
				expect(edited.entity_id).toBe("person-7");
			});
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
				});
				expect(edited.status).toBe("completed");
				expect(edited.completed_at).toMatch(LOCAL_DATETIME_RE);
				expect("dropped_at" in edited).toBe(false);
			});

			it("active→dropped adds a valid dropped_at and omits completed_at", () => {
				const draft = seedCreateProject(proposed);
				const edited = overlayCreateProject(proposed, {
					...draft,
					status: "dropped",
				});
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
				});
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
				});
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
				});
				expect(edited.completed_at).toBe("2026-06-01T09:00:00");
			});
		});

		it("omits blank outcome and note keys", () => {
			const draft = seedCreateProject(proposed);
			const edited = overlayCreateProject(proposed, {
				...draft,
				outcome: "",
				note: "",
			});
			expect("outcome" in edited).toBe(false);
			expect("note" in edited).toBe(false);
		});

		it("does not mutate the proposed payload (overlay clones)", () => {
			const draft = seedCreateProject(proposed);
			overlayCreateProject(proposed, { ...draft, name: "Changed" });
			expect(proposed.name).toBe("Ship API v2 migration");
		});

		// update_project rides this same create overlay (FULL-DOCUMENT REPLACE): the
		// proposed payload carries a top-level `entity_id` plus the review cadence and
		// dates, all of which clonePayload must ride through untouched.
		describe("full-replace update path (proposed carries entity_id + cadence + dates)", () => {
			const updateProposed = {
				entity_id: "project-7",
				name: "Ship API v2 migration",
				outcome: "All clients on v2 by Q3.",
				note: "Coordinate with the platform team.",
				status: "active",
				review_every: { interval: 1, unit: "week" },
				next_review_at: "2026-07-01T09:00:00",
				last_reviewed_at: "2026-06-01T09:00:00",
				due_at: "2026-09-30T00:00:00",
			};

			it("preserves entity_id, review cadence, and dates when editing name", () => {
				const draft = seedCreateProject(updateProposed);
				const edited = overlayCreateProject(updateProposed, {
					...draft,
					name: "Ship API v2",
				});
				expect(edited).toEqual({
					entity_id: "project-7",
					name: "Ship API v2",
					outcome: "All clients on v2 by Q3.",
					note: "Coordinate with the platform team.",
					status: "active",
					review_every: { interval: 1, unit: "week" },
					next_review_at: "2026-07-01T09:00:00",
					last_reviewed_at: "2026-06-01T09:00:00",
					due_at: "2026-09-30T00:00:00",
				});
			});

			it("preserves the entity_id across a status↔timestamp coupling change", () => {
				const completedProposed = {
					entity_id: "project-9",
					name: "Done project",
					status: "completed",
					completed_at: "2026-06-01T09:00:00",
				};
				const draft = seedCreateProject(completedProposed);
				const edited = overlayCreateProject(completedProposed, {
					...draft,
					status: "on_hold",
				});
				expect(edited.status).toBe("on_hold");
				expect("completed_at" in edited).toBe(false);
				expect(edited.entity_id).toBe("project-9");
			});

			it("does not mutate the proposed payload, leaving the entity_id intact", () => {
				const draft = seedCreateProject(updateProposed);
				overlayCreateProject(updateProposed, { ...draft, name: "Changed" });
				expect(updateProposed.name).toBe("Ship API v2 migration");
				expect(updateProposed.entity_id).toBe("project-7");
			});
		});
	});
});
