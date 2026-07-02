import { describe, expect, it } from "vitest";
import {
	type CreatePersonDraft,
	type CreateProjectDraft,
	type CreateTodoDraft,
	type GtdEditVariant,
	gtdEditVariant,
	isGtdEditKind,
	overlayCreatePerson,
	overlayCreateProject,
	overlayCreateTodo,
	overlayUpdateTodo,
	seedCreatePerson,
	seedCreateProject,
	seedCreateTodo,
	seedUpdateTodo,
	type UpdateTodoDraft,
} from "@/lib/proposalEdit.js";

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
				}) as Record<string, unknown>;
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
				}) as Record<string, unknown>;
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

describe("proposalEdit — update_todo (partial)", () => {
	// A representative partial: status surfaced + title surfaced, plus an unsurfaced
	// `todo` key (project_id) and all three ref lists that must ride byte-for-byte.
	const proposed = {
		todo_id: "todo-7",
		todo: {
			title: "Email Alice (done)",
			note: "Send the migration plan.",
			status: "completed",
			completed_at: "2026-06-01T09:00:00",
			project_id: "proj-1",
		},
		set_person_refs: [{ person_id: "dave-1", role: "related" }],
		add_person_refs: [{ person_id: "carol-1", role: "waiting_on" }],
		remove_person_ids: ["bob-1"],
	};

	describe("seed", () => {
		it("seeds title/note/status and marks them present from a partial that carries them", () => {
			expect(seedUpdateTodo(proposed)).toEqual({
				title: "Email Alice (done)",
				titlePresent: true,
				note: "Send the migration plan.",
				status: "completed",
				statusPresent: true,
			} satisfies UpdateTodoDraft);
		});

		it("marks status absent when the partial carries no status", () => {
			const draft = seedUpdateTodo({
				todo_id: "todo-9",
				todo: { title: "Rename me" },
			});
			expect(draft.statusPresent).toBe(false);
			expect(draft.titlePresent).toBe(true);
			expect(draft.status).toBe("active");
		});

		it("marks title absent when the partial carries no title", () => {
			const draft = seedUpdateTodo({
				todo_id: "todo-9",
				todo: { note: "Just a note change" },
			});
			expect(draft.titlePresent).toBe(false);
			expect(draft.note).toBe("Just a note change");
		});

		it("seeds an empty, all-absent draft from a null payload without throwing", () => {
			expect(seedUpdateTodo(null)).toEqual({
				title: "",
				titlePresent: false,
				note: "",
				status: "active",
				statusPresent: false,
			});
		});

		it("seeds an empty, all-absent draft from a payload whose todo is missing", () => {
			expect(seedUpdateTodo({ todo_id: "todo-9" })).toEqual({
				title: "",
				titlePresent: false,
				note: "",
				status: "active",
				statusPresent: false,
			});
		});
	});

	describe("overlay", () => {
		it("editing title preserves todo_id, all ref lists, and unsurfaced todo keys", () => {
			const draft = seedUpdateTodo(proposed);
			const edited = overlayUpdateTodo(proposed, {
				...draft,
				title: "Email Alice about the Q3 migration",
			});
			expect(edited).toEqual({
				todo_id: "todo-7",
				todo: {
					title: "Email Alice about the Q3 migration",
					note: "Send the migration plan.",
					status: "completed",
					completed_at: "2026-06-01T09:00:00",
					project_id: "proj-1",
				},
				set_person_refs: [{ person_id: "dave-1", role: "related" }],
				add_person_refs: [{ person_id: "carol-1", role: "waiting_on" }],
				remove_person_ids: ["bob-1"],
			});
		});

		it("does not mutate the proposed payload (overlay clones)", () => {
			const draft = seedUpdateTodo(proposed);
			overlayUpdateTodo(proposed, { ...draft, title: "Changed" });
			expect(proposed.todo.title).toBe("Email Alice (done)");
		});

		it("blanking a proposed note omits the note key from the partial", () => {
			const draft = seedUpdateTodo(proposed);
			const edited = overlayUpdateTodo(proposed, {
				...draft,
				note: "",
			}) as { todo: Record<string, unknown> };
			expect("note" in edited.todo).toBe(false);
		});

		it("emits no status key when the partial had no status (status unsurfaced)", () => {
			const noStatus = {
				todo_id: "todo-9",
				todo: { title: "Rename me", note: "keep" },
			};
			const draft = seedUpdateTodo(noStatus);
			const edited = overlayUpdateTodo(noStatus, {
				...draft,
				title: "Renamed",
			}) as { todo: Record<string, unknown> };
			expect("status" in edited.todo).toBe(false);
			expect(edited.todo.title).toBe("Renamed");
		});

		it("emits no title key when the partial had no title (title unsurfaced)", () => {
			const noTitle = {
				todo_id: "todo-9",
				todo: { note: "Just a note change" },
			};
			const draft = seedUpdateTodo(noTitle);
			const edited = overlayUpdateTodo(noTitle, {
				...draft,
				note: "An edited note",
			}) as { todo: Record<string, unknown> };
			expect("title" in edited.todo).toBe(false);
			expect(edited.todo.note).toBe("An edited note");
		});

		describe("status↔timestamp coupling (when status surfaced + changed)", () => {
			it("completed→active clears completed_at and dropped_at within the partial", () => {
				const draft = seedUpdateTodo(proposed);
				const edited = overlayUpdateTodo(proposed, {
					...draft,
					status: "active",
				}) as { todo: Record<string, unknown> };
				expect(edited.todo.status).toBe("active");
				expect("completed_at" in edited.todo).toBe(false);
				expect("dropped_at" in edited.todo).toBe(false);
			});

			it("active→completed stamps completed_at and omits dropped_at within the partial", () => {
				const activeProposed = {
					todo_id: "todo-3",
					todo: { title: "Do it", status: "active" },
				};
				const draft = seedUpdateTodo(activeProposed);
				const edited = overlayUpdateTodo(activeProposed, {
					...draft,
					status: "completed",
				}) as { todo: Record<string, unknown> };
				expect(edited.todo.status).toBe("completed");
				expect(edited.todo.completed_at).toMatch(LOCAL_DATETIME_RE);
				expect("dropped_at" in edited.todo).toBe(false);
			});

			it("leaves a stored completed_at intact when surfaced status is unchanged", () => {
				const draft = seedUpdateTodo(proposed);
				const edited = overlayUpdateTodo(proposed, {
					...draft,
					title: "Email Alice (done, edited)",
				}) as { todo: Record<string, unknown> };
				expect(edited.todo.completed_at).toBe("2026-06-01T09:00:00");
			});
		});
	});
});

// The single source of GTD-editability: `gtdEditVariant` maps the 6 GTD wire
// kinds to 4 behavior variants (update_person/update_project collapse onto their
// create twins), and `isGtdEditKind` is the boolean derived from it. The resolver
// must reject every non-GTD kind — AND every prototype key ("toString",
// "constructor", "__proto__", "hasOwnProperty") — with `null`; a bare `?? null`
// would leak inherited Object.prototype members for the prototype keys.

describe("gtdEditVariant / isGtdEditKind", () => {
	const GTD_KINDS: ReadonlyArray<[string, GtdEditVariant]> = [
		["create_todo", "todo_create"],
		["update_todo", "todo_update"],
		["create_person", "person"],
		["update_person", "person"],
		["create_project", "project"],
		["update_project", "project"],
	];

	// Every kind the resolver must reject: real non-GTD wire kinds + the bare ""/
	// nonsense, AND the Object.prototype keys that a bare `?? null` would leak.
	const NULL_KINDS: ReadonlyArray<string> = [
		"create_journal_entry",
		"update_journal_entry",
		"delete_todo",
		"apply_intent_graph",
		"",
		"nonsense_kind",
		"toString",
		"constructor",
		"__proto__",
		"hasOwnProperty",
	];

	it.each(GTD_KINDS)("maps %s to its variant", (kind, variant) => {
		expect(gtdEditVariant(kind)).toBe(variant);
	});

	it.each(GTD_KINDS)("isGtdEditKind is true for the GTD kind %s", (kind) => {
		expect(isGtdEditKind(kind)).toBe(true);
	});

	it.each(NULL_KINDS)("returns null for the non-editable kind %s", (kind) => {
		expect(gtdEditVariant(kind)).toBeNull();
	});

	it.each(
		NULL_KINDS,
	)("isGtdEditKind is false for the non-editable kind %s", (kind) => {
		expect(isGtdEditKind(kind)).toBe(false);
	});

	it("isGtdEditKind(k) === (gtdEditVariant(k) !== null) across the full set", () => {
		for (const [kind] of GTD_KINDS) {
			expect(isGtdEditKind(kind)).toBe(gtdEditVariant(kind) !== null);
		}
		for (const kind of NULL_KINDS) {
			expect(isGtdEditKind(kind)).toBe(gtdEditVariant(kind) !== null);
		}
	});

	it("isGtdEditKind is true for exactly the 6 GTD kinds and false otherwise", () => {
		expect(GTD_KINDS.filter(([kind]) => isGtdEditKind(kind))).toHaveLength(6);
		expect(NULL_KINDS.filter((kind) => isGtdEditKind(kind))).toHaveLength(0);
	});
});
