import { createMedia, updateMedia } from "@inkstone/protocol";
import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import type {
	JournalEntry,
	Media,
	Person,
	Project,
	Todo,
} from "@/lib/libraryItems";
import {
	buildJournalEntry,
	buildJournalReference,
	buildMedia,
	buildPerson,
	buildProject,
	buildRecurrencePreviewParams,
	buildTodo,
	type JournalDraft,
	journalDraftFromVm,
	journalScalarsDiffer,
	type LiveEntityRow,
	type MediaDraft,
	mediaDraftFromVm,
	type PersonDraft,
	type ProjectDraft,
	parseJournalEntry,
	parseMedia,
	parsePerson,
	parseProject,
	parseTodo,
	personDraftFromVm,
	projectDraftFromVm,
	recurAnchorDatePresent,
	stagedNewChip,
	type TodoDraft,
	todoDraftFromVm,
} from "./entityCodec.js";

// `created_at` is pinned to fixed numbers; `createdAt`'s toLocaleDateString() is
// timezone/locale-fragile, so the assertions below pin the structural VM fields
// and `recency === row.created_at`, not the rendered locale string.

describe("entityCodec parse — journal_entry", () => {
	const row = (data: unknown, refs?: LiveEntityRow["refs"]): LiveEntityRow => ({
		id: "je_1",
		data,
		created_at: 1000,
		refs,
	});

	it("parses a valid entry, resolving entity_ref nodes against refs and carrying ended_at", () => {
		const vm = parseJournalEntry(
			row(
				{
					occurred_at: "2026-06-10T09:00:00",
					ended_at: "2026-06-10T10:00:00",
					body: [
						{ type: "text", text: "Met " },
						{ type: "entity_ref", ref_id: "r1" },
						{ type: "text", text: " today." },
					],
				},
				[
					{
						id: "r1",
						source_entity_id: "je_1",
						target_entity_id: "person_ada",
						target_entity_type: "person",
						target_title: "Ada Lovelace",
						label_snapshot: "Ada",
					},
				],
			),
		);
		expect(vm.id).toBe("je_1");
		expect(vm.kind).toBe("journal_entry");
		expect(vm.occurredAt).toBe("2026-06-10T09:00:00");
		expect(vm.endedAt).toBe("2026-06-10T10:00:00");
		expect(vm.recency).toBe(1000);
		expect(vm.body).toEqual([
			{ type: "text", text: "Met " },
			{
				type: "entity_ref",
				refId: "r1",
				targetEntityId: "person_ada",
				targetKind: "person",
				targetTitle: "Ada Lovelace",
				labelSnapshot: "Ada",
			},
			{ type: "text", text: " today." },
		]);
	});

	it("leaves endedAt undefined when ended_at is absent or non-string", () => {
		const vm = parseJournalEntry(
			row({
				occurred_at: "2026-06-10T09:00:00",
				body: [{ type: "text", text: "Note" }],
			}),
		);
		expect(vm.endedAt).toBeUndefined();
	});

	it("leaves entity_ref target fields undefined when the ref id is unresolved", () => {
		const vm = parseJournalEntry(
			row({
				occurred_at: "2026-06-10T09:00:00",
				body: [{ type: "entity_ref", ref_id: "missing" }],
			}),
		);
		expect(vm.body).toEqual([
			{
				type: "entity_ref",
				refId: "missing",
				targetEntityId: undefined,
				targetKind: undefined,
				targetTitle: undefined,
				labelSnapshot: undefined,
			},
		]);
	});

	it("throws on a non-string occurred_at", () => {
		expect(() =>
			parseJournalEntry(
				row({ occurred_at: 123, body: [{ type: "text", text: "x" }] }),
			),
		).toThrow();
	});

	it("throws on an occurred_at that fails the local-datetime regex", () => {
		expect(() =>
			parseJournalEntry(
				row({
					occurred_at: "2026-06-10",
					body: [{ type: "text", text: "x" }],
				}),
			),
		).toThrow();
	});

	it("throws on an empty body", () => {
		expect(() =>
			parseJournalEntry(row({ occurred_at: "2026-06-10T09:00:00", body: [] })),
		).toThrow();
	});

	it("throws on a non-array body", () => {
		expect(() =>
			parseJournalEntry(
				row({ occurred_at: "2026-06-10T09:00:00", body: "nope" }),
			),
		).toThrow();
	});

	it("throws on a non-object body node", () => {
		expect(() =>
			parseJournalEntry(
				row({ occurred_at: "2026-06-10T09:00:00", body: ["nope"] }),
			),
		).toThrow();
	});

	it("throws on an entity_ref with an empty ref_id", () => {
		expect(() =>
			parseJournalEntry(
				row({
					occurred_at: "2026-06-10T09:00:00",
					body: [{ type: "entity_ref", ref_id: "  " }],
				}),
			),
		).toThrow();
	});

	it("throws on an unknown node type", () => {
		expect(() =>
			parseJournalEntry(
				row({
					occurred_at: "2026-06-10T09:00:00",
					body: [{ type: "image", src: "x" }],
				}),
			),
		).toThrow();
	});

	it("throws on an empty text node", () => {
		expect(() =>
			parseJournalEntry(
				row({
					occurred_at: "2026-06-10T09:00:00",
					body: [{ type: "text", text: "   " }],
				}),
			),
		).toThrow();
	});
});

describe("entityCodec parse — todo", () => {
	const row = (
		data: unknown,
		extra: Partial<LiveEntityRow> = {},
	): LiveEntityRow => ({ id: "t_1", data, created_at: 2000, ...extra });

	it("parses a full row with status, recurrence, and personRefs (snake→camel)", () => {
		const vm = parseTodo(
			row(
				{
					title: "Water the plants",
					note: "back garden",
					status: "completed",
					project_id: "proj_1",
					defer_at: "2026-06-14T09:00:00",
					due_at: "2026-06-20T17:00:00",
					completed_at: "2026-06-15T08:00:00",
					recurrence: {
						interval: 2,
						unit: "week",
						anchor: "defer_at",
						end: { after_count: 10 },
					},
				},
				{
					person_refs: [
						{ person_id: "p_a", role: "waiting_on" },
						{ person_id: "p_b", role: "related" },
					],
				},
			),
		);
		expect(vm.id).toBe("t_1");
		expect(vm.kind).toBe("todo");
		expect(vm.title).toBe("Water the plants");
		expect(vm.note).toBe("back garden");
		expect(vm.status).toBe("completed");
		expect(vm.projectId).toBe("proj_1");
		expect(vm.deferAt).toBe("2026-06-14T09:00:00");
		expect(vm.dueAt).toBe("2026-06-20T17:00:00");
		expect(vm.completedAt).toBe("2026-06-15T08:00:00");
		expect(vm.recency).toBe(2000);
		expect(vm.recurrence).toEqual({
			interval: 2,
			unit: "week",
			anchor: "defer_at",
			end: { afterCount: 10 },
		});
		expect(vm.personRefs).toEqual([
			{ personId: "p_a", role: "waiting_on" },
			{ personId: "p_b", role: "related" },
		]);
	});

	it("defaults a sparse/empty-data row without throwing", () => {
		const vm = parseTodo(row({}));
		expect(vm.title).toBe("Untitled");
		expect(vm.status).toBe("active");
		expect(vm.personRefs).toEqual([]);
		expect(vm.recurrence).toBeUndefined();
		expect(vm.note).toBeUndefined();
		expect(vm.projectId).toBeUndefined();
		expect(vm.deferAt).toBeUndefined();
		expect(vm.dueAt).toBeUndefined();
	});

	it("carries a Journal-Entry source as provenance (ADR-0030)", () => {
		const vm = parseTodo(row({}, { source: { journal_entry_id: "je_1" } }));
		expect(vm.source).toEqual({
			kind: "journal_entry",
			journalEntryId: "je_1",
		});
	});

	it("carries a Message source as Thread provenance (ADR-0030)", () => {
		const vm = parseTodo(
			row(
				{},
				{ source: { thread_id: "thr_1", thread_title: "Morning brain dump" } },
			),
		);
		expect(vm.source).toEqual({
			kind: "thread",
			threadId: "thr_1",
			threadTitle: "Morning brain dump",
			messageId: undefined,
		});
	});

	it("surfaces the capturing messageId on a Thread source (#184)", () => {
		const vm = parseTodo(
			row(
				{},
				{
					source: {
						thread_id: "thr_1",
						thread_title: "Morning brain dump",
						message_id: "msg_1",
					},
				},
			),
		);
		expect(vm.source).toEqual({
			kind: "thread",
			threadId: "thr_1",
			threadTitle: "Morning brain dump",
			messageId: "msg_1",
		});
	});

	it("treats an empty-string message_id as absent (anchorless fallback, #184)", () => {
		// The empty-id guard mirrors thread_id/journal_entry_id: a blank message id
		// is malformed, not a valid anchor — surface messageId: undefined so the
		// "Captured from" deep-link falls back to a plain thread-open.
		const vm = parseTodo(
			row(
				{},
				{
					source: {
						thread_id: "thr_1",
						thread_title: "Morning brain dump",
						message_id: "  ",
					},
				},
			),
		);
		expect(vm.source).toEqual({
			kind: "thread",
			threadId: "thr_1",
			threadTitle: "Morning brain dump",
			messageId: undefined,
		});
	});

	it("reports no provenance for a user-authored row (no source)", () => {
		expect(parseTodo(row({})).source).toBeUndefined();
	});

	it("ignores a thin/empty source object rather than crashing", () => {
		expect(parseTodo(row({}, { source: {} })).source).toBeUndefined();
	});

	it("treats an empty-string source id as absent (no dead link)", () => {
		// An empty thread_id/journal_entry_id is malformed, not a valid target —
		// degrade to undefined so the inspector never renders a link to nowhere.
		expect(
			parseTodo(row({}, { source: { thread_id: "" } })).source,
		).toBeUndefined();
		expect(
			parseTodo(row({}, { source: { journal_entry_id: "  " } })).source,
		).toBeUndefined();
	});

	it("prefers the Journal-Entry id when both source fields are present", () => {
		// Core's exactly-one-kind row makes this unreachable, but the parser must
		// resolve deterministically regardless: journal_entry_id wins.
		const vm = parseTodo(
			row({}, { source: { journal_entry_id: "je_1", thread_id: "thr_1" } }),
		);
		expect(vm.source).toEqual({
			kind: "journal_entry",
			journalEntryId: "je_1",
		});
	});

	it("coerces an unknown status to active", () => {
		expect(parseTodo(row({ status: "bogus" })).status).toBe("active");
	});

	it("drops a malformed recurrence rule (missing unit) → undefined", () => {
		expect(
			parseTodo(row({ recurrence: { interval: 2 } })).recurrence,
		).toBeUndefined();
	});

	// Reaches the RECURRENCE_UNITS membership check directly: a present-but-bogus
	// string unit clears the `typeof unit === "string"` guard the missing-unit case
	// short-circuits at, so this is the only fixture exercising the reject side of
	// the `RECURRENCE_UNITS.some((u) => u.value === r.unit)` predicate.
	it("drops a recurrence rule with an unrecognized unit string → undefined", () => {
		expect(
			parseTodo(
				row({
					recurrence: { interval: 1, unit: "fortnight", anchor: "due_at" },
				}),
			).recurrence,
		).toBeUndefined();
	});

	it("maps an until end condition", () => {
		const vm = parseTodo(
			row({
				recurrence: {
					interval: 1,
					unit: "month",
					anchor: "due_at",
					end: { until: "2027-01-01T00:00:00" },
				},
			}),
		);
		expect(vm.recurrence).toEqual({
			interval: 1,
			unit: "month",
			anchor: "due_at",
			end: { until: "2027-01-01T00:00:00" },
		});
	});

	// Slice-2 follow-up: a stored dropped_at must surface on the view model so the
	// editor renders/round-trips the dropped status's timestamp.
	it("carries dropped_at onto droppedAt", () => {
		const vm = parseTodo(
			row({ status: "dropped", dropped_at: "2026-06-15T08:00:00" }),
		);
		expect(vm.status).toBe("dropped");
		expect(vm.droppedAt).toBe("2026-06-15T08:00:00");
	});

	it("drops a recurrence rule with an invalid anchor → undefined", () => {
		expect(
			parseTodo(
				row({ recurrence: { interval: 1, unit: "week", anchor: "bogus" } }),
			).recurrence,
		).toBeUndefined();
	});
});

describe("entityCodec parse — person", () => {
	const row = (data: unknown): LiveEntityRow => ({
		id: "p_1",
		data,
		created_at: 3000,
	});

	it("parses a full row", () => {
		const vm = parsePerson(
			row({ name: "Priya Nair", note: "Owns SDK", aliases: ["Pri", "PN"] }),
		);
		expect(vm.id).toBe("p_1");
		expect(vm.kind).toBe("person");
		expect(vm.name).toBe("Priya Nair");
		expect(vm.note).toBe("Owns SDK");
		expect(vm.aliases).toEqual(["Pri", "PN"]);
		expect(vm.recency).toBe(3000);
	});

	it("defaults the name to Unnamed on a sparse row", () => {
		expect(parsePerson(row({})).name).toBe("Unnamed");
	});

	it("filters non-string aliases and yields undefined when none remain", () => {
		expect(
			parsePerson(row({ aliases: ["ok", 5, null, "two"] })).aliases,
		).toEqual(["ok", "two"]);
		expect(parsePerson(row({ aliases: [1, 2] })).aliases).toBeUndefined();
		expect(parsePerson(row({ aliases: [] })).aliases).toBeUndefined();
		expect(parsePerson(row({ aliases: "nope" })).aliases).toBeUndefined();
	});
});

describe("entityCodec parse — project", () => {
	const row = (data: unknown): LiveEntityRow => ({
		id: "proj_1",
		data,
		created_at: 4000,
	});

	it("parses a full row and carries data verbatim (including projection-omitted fields)", () => {
		const stored = {
			name: "API v2 migration",
			status: "on_hold",
			outcome: "Rename /contacts",
			note: "blocked",
			next_review_at: "2026-06-20T00:00:00",
			last_reviewed_at: "2026-06-01T00:00:00",
			review_every: { interval: 1, unit: "week" },
			due_at: "2026-07-01T00:00:00",
			defer_at: "2026-06-15T00:00:00",
		};
		const vm = parseProject(row(stored));
		expect(vm.id).toBe("proj_1");
		expect(vm.kind).toBe("project");
		expect(vm.name).toBe("API v2 migration");
		expect(vm.status).toBe("on_hold");
		expect(vm.outcome).toBe("Rename /contacts");
		expect(vm.note).toBe("blocked");
		expect(vm.nextReviewAt).toBe("2026-06-20T00:00:00");
		expect(vm.lastReviewedAt).toBe("2026-06-01T00:00:00");
		// The verbatim stored object is carried whole — including review_every /
		// due_at / defer_at that the projected fields omit.
		expect(vm.data).toEqual(stored);
		expect(vm.data).not.toBe(stored); // shallow copy, not the same reference
	});

	it("defaults a sparse row to Untitled/active and carries an empty data object", () => {
		const vm = parseProject(row({}));
		expect(vm.name).toBe("Untitled");
		expect(vm.status).toBe("active");
		expect(vm.data).toEqual({});
	});

	it("coerces an unknown status to active", () => {
		expect(parseProject(row({ status: "bogus" })).status).toBe("active");
	});
});

// Slice-2: the parsers decode `row.data` against the shared relaxed read schema
// (@inkstone/protocol) before coercing. These pin the two properties that make
// that refactor safe: (1) decode is LENIENT — an unknown/legacy stored key never
// makes a parser throw; (2) parseProject's verbatim `data` passthrough is
// INDEPENDENT of the decoded fields, so the full-document-replace update_project
// still round-trips shapes the decode/write schema can't model.
describe("entityCodec parse — decode-against-read-schema (slice-2 seam)", () => {
	it("parseTodo tolerates an unknown stored key without throwing", () => {
		const vm = parseTodo({
			id: "t_x",
			data: { title: "ship it", legacy_field: { nested: 1 }, status: "active" },
			created_at: 2500,
		});
		expect(vm.title).toBe("ship it");
		expect(vm.status).toBe("active");
	});

	it("parsePerson tolerates an unknown stored key without throwing", () => {
		const vm = parsePerson({
			id: "p_x",
			data: { name: "Morris", retired_field: 42 },
			created_at: 3500,
		});
		expect(vm.name).toBe("Morris");
	});

	it("parseProject carries an un-decodable review_every verbatim onto vm.data", () => {
		// `review_every: "P1W"` (an ISO-8601 duration STRING) is a real legacy shape
		// the write `reviewEvery` struct schema cannot decode. The verbatim
		// passthrough must survive it so update_project's full-replace round-trips.
		const vm = parseProject({
			id: "proj_x",
			data: { name: "Legacy", review_every: "P1W", unknown_key: true },
			created_at: 4500,
		});
		expect(vm.name).toBe("Legacy");
		expect((vm.data as Record<string, unknown>).review_every).toBe("P1W");
		expect((vm.data as Record<string, unknown>).unknown_key).toBe(true);
	});
});

// The fail-soft contract the decode MUST preserve: the four non-JE parsers never
// throw, so a malformed row renders with defaults rather than being dropped by
// useLibraryItems' parseKind. Two ways decode could regress this and still pass
// the rest of the suite: (a) an array `data` (typeof [] === "object") slipping
// past asRecord into an S.Struct decode that rejects arrays; (b) tightening a
// readField from S.Unknown so a wrong-typed scalar is rejected. Both are pinned
// here — the latter reds the moment readField stops being S.optional(S.Unknown).
describe("entityCodec parse — fail-soft decode never throws (slice-2 contract)", () => {
	const failSoft = [
		{ name: "todo", parse: parseTodo, titleKey: "title" as const },
		{ name: "person", parse: parsePerson, titleKey: "name" as const },
		{ name: "project", parse: parseProject, titleKey: "name" as const },
		{ name: "media", parse: parseMedia, titleKey: "title" as const },
	];

	for (const { name, parse } of failSoft) {
		it(`parse${name} defaults (never throws) on an ARRAY data`, () => {
			expect(() =>
				parse({ id: `${name}_arr`, data: ["nope"], created_at: 9000 }),
			).not.toThrow();
		});

		it(`parse${name} defaults (never throws) on a wrong-typed scalar field`, () => {
			// A numeric `title`/`name` is a wrong-typed top-level scalar. The decode
			// must stay total (S.Unknown) and let the imperative coercion default it;
			// tightening the read field to S.String would throw here and drop the row.
			const vm = parse({
				id: `${name}_badscalar`,
				data: { title: 123, name: 123 },
				created_at: 9100,
			}) as unknown as Record<string, unknown>;
			expect(typeof vm.title === "string" || typeof vm.name === "string").toBe(
				true,
			);
		});
	}
});

describe("entityCodec parse — media", () => {
	const row = (data: unknown): LiveEntityRow => ({
		id: "m_1",
		data,
		created_at: 5000,
	});

	it("parses a full row", () => {
		const vm = parseMedia(
			row({
				title: "Dune",
				medium: "book",
				state: "done",
				rating: 5,
				finished_at: "2026-06-20T00:00:00",
				url: "https://example.com/dune",
				note: "reread",
				tags: ["scifi", "classic"],
			}),
		);
		expect(vm.id).toBe("m_1");
		expect(vm.kind).toBe("media");
		expect(vm.title).toBe("Dune");
		expect(vm.medium).toBe("book");
		expect(vm.state).toBe("done");
		expect(vm.rating).toBe(5);
		expect(vm.finishedAt).toBe("2026-06-20T00:00:00");
		expect(vm.url).toBe("https://example.com/dune");
		expect(vm.note).toBe("reread");
		expect(vm.tags).toEqual(["scifi", "classic"]);
		expect(vm.recency).toBe(5000);
	});

	// DEFAULT-TOLERANT (ADR-0059): a sparse / pre-migration row missing medium/state
	// must never crash the inspector — it degrades to medium='link', state='done'
	// (the migration's bookmark→media defaults), like asTodoStatus degrades.
	it("default-tolerates a sparse row missing medium/state (degrade, never crash)", () => {
		const vm = parseMedia(row({ title: "A saved link" }));
		expect(vm.title).toBe("A saved link");
		expect(vm.medium).toBe("link");
		expect(vm.state).toBe("done");
		expect(vm.rating).toBeUndefined();
		expect(vm.finishedAt).toBeUndefined();
	});

	it("degrades an out-of-domain medium/state to the default", () => {
		const vm = parseMedia(
			row({ title: "x", medium: "podcast", state: "reading" }),
		);
		expect(vm.medium).toBe("link");
		expect(vm.state).toBe("done");
	});

	it("defaults the title to Untitled on an empty row", () => {
		const vm = parseMedia(row({}));
		expect(vm.title).toBe("Untitled");
		expect(vm.medium).toBe("link");
		expect(vm.state).toBe("done");
	});

	it("filters non-string tags and yields undefined when none remain", () => {
		expect(parseMedia(row({ tags: ["a", 1, "b"] })).tags).toEqual(["a", "b"]);
		expect(parseMedia(row({ tags: [1, 2] })).tags).toBeUndefined();
		expect(parseMedia(row({ tags: [] })).tags).toBeUndefined();
	});

	it("drops a non-number rating", () => {
		expect(
			parseMedia(row({ state: "done", rating: "5" })).rating,
		).toBeUndefined();
	});
});

// The build direction, proven React-free (the TodoEditor.test.tsx oracle proves
// it through the component; this pins the codec standalone). `localNowString()`
// is live, so status-timestamp cases assert the *_at value is a string, not an
// exact instant — matching the oracle's stance.
describe("entityCodec build — todo create", () => {
	const draft = (over: Partial<TodoDraft> = {}): TodoDraft => ({
		...todoDraftFromVm(undefined),
		...over,
	});

	it("emits create_todo with only the filled fields (title-only)", () => {
		expect(
			buildTodo({ mode: "create", draft: draft({ title: "Buy milk" }) }),
		).toEqual({
			mutation_kind: "create_todo",
			payload: { todo: { title: "Buy milk" } },
		});
	});

	it("nests a project link and a person ref when chosen", () => {
		expect(
			buildTodo({
				mode: "create",
				draft: draft({
					title: "Get the schedule",
					projectId: "proj_1",
					personRefs: [{ personId: "p_a", role: "waiting_on" }],
				}),
			}),
		).toEqual({
			mutation_kind: "create_todo",
			payload: {
				todo: { title: "Get the schedule", project_id: "proj_1" },
				person_refs: [{ person_id: "p_a", role: "waiting_on" }],
			},
		});
	});

	it("emits person_refs for BOTH a waiting_on and a related row", () => {
		expect(
			buildTodo({
				mode: "create",
				draft: draft({
					title: "Get the schedule",
					personRefs: [
						{ personId: "p_a", role: "waiting_on" },
						{ personId: "p_b", role: "related" },
					],
				}),
			}),
		).toEqual({
			mutation_kind: "create_todo",
			payload: {
				todo: { title: "Get the schedule" },
				person_refs: [
					{ person_id: "p_a", role: "waiting_on" },
					{ person_id: "p_b", role: "related" },
				],
			},
		});
	});

	it("omits person_refs when no person is linked", () => {
		const params = buildTodo({
			mode: "create",
			draft: draft({ title: "Solo task" }),
		});
		expect(params?.payload).not.toHaveProperty("person_refs");
	});

	it("sets status + matching timestamp (completed) and never dropped_at on create", () => {
		const params = buildTodo({
			mode: "create",
			draft: draft({ title: "Done thing", status: "completed" }),
		});
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo.status).toBe("completed");
		expect(typeof todo.completed_at).toBe("string");
		expect(todo).not.toHaveProperty("dropped_at");
	});

	it("emits the snake_case rule when recurrence is on (anchor date present)", () => {
		expect(
			buildTodo({
				mode: "create",
				draft: draft({
					title: "Water the plants",
					deferDay: "2026-07-01",
					recurs: true,
					recurAnchor: "defer_at",
				}),
			}),
		).toEqual({
			mutation_kind: "create_todo",
			payload: {
				todo: {
					title: "Water the plants",
					defer_at: "2026-07-01T00:00:00",
					recurrence: {
						interval: 1,
						unit: "week",
						anchor: "defer_at",
					},
				},
			},
		});
	});

	it("omits the recurrence key when Repeats is off", () => {
		const params = buildTodo({
			mode: "create",
			draft: draft({ title: "One-off task" }),
		});
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo).not.toHaveProperty("recurrence");
	});

	// The codec OWNS the anchor gate (recurActive = recurs && recurAnchorDatePresent):
	// when Repeats is on but the chosen anchor's date is absent, Core would reject the
	// rule, so the codec omits it. The editor's Save-block makes this state hard to reach
	// today, but the codec must be correct standalone — a future caller routed through
	// build() without that guard can't be allowed to emit an anchorless rule.
	it("omits recurrence when Repeats is on but the anchor date is absent", () => {
		const params = buildTodo({
			mode: "create",
			draft: draft({
				title: "Repeat me",
				recurs: true,
				recurAnchor: "due_at",
				// dueDay intentionally left "" — the anchor's date is missing.
			}),
		});
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo).not.toHaveProperty("recurrence");
	});

	// End condition (#227): the editor's End dropdown folds into rule.end.
	it("folds an `until` end condition at day granularity", () => {
		const params = buildTodo({
			mode: "create",
			draft: draft({
				title: "Weekly standup",
				deferDay: "2026-07-01",
				recurs: true,
				recurAnchor: "defer_at",
				recurEnd: "until",
				recurUntilDay: "2026-12-31",
			}),
		});
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo.recurrence).toEqual({
			interval: 1,
			unit: "week",
			anchor: "defer_at",
			end: { until: "2026-12-31T00:00:00" },
		});
	});

	it("folds an `after_count` end condition from the count field", () => {
		const params = buildTodo({
			mode: "create",
			draft: draft({
				title: "Take pills",
				deferDay: "2026-07-01",
				recurs: true,
				recurAnchor: "defer_at",
				recurEnd: "after",
				recurAfterCount: "10",
			}),
		});
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo.recurrence).toEqual({
			interval: 1,
			unit: "week",
			anchor: "defer_at",
			end: { after_count: 10 },
		});
	});

	it("omits `end` when the End choice is `never` (the two are mutually exclusive)", () => {
		const params = buildTodo({
			mode: "create",
			draft: draft({
				title: "Forever task",
				deferDay: "2026-07-01",
				recurs: true,
				recurAnchor: "defer_at",
				recurEnd: "never",
				// Stale values in the unused branches must not leak into the rule.
				recurUntilDay: "2026-12-31",
				recurAfterCount: "10",
			}),
		});
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo.recurrence).toEqual({
			interval: 1,
			unit: "week",
			anchor: "defer_at",
		});
		expect(todo.recurrence).not.toHaveProperty("end");
	});

	it("reads a stored `until` end back into the draft fields", () => {
		const d = todoDraftFromVm({
			id: "t_u",
			kind: "todo",
			title: "Bounded",
			status: "active",
			personRefs: [],
			recency: 1,
			createdAt: "fixture",
			deferAt: "2026-07-01T00:00:00",
			recurrence: {
				interval: 1,
				unit: "week",
				anchor: "defer_at",
				end: { until: "2026-12-31T00:00:00" },
			},
		});
		expect(d.recurEnd).toBe("until");
		expect(d.recurUntilDay).toBe("2026-12-31");
		expect(d.recurAfterCount).toBe("");
	});

	it("reads a stored `after_count` end back into the draft fields", () => {
		const d = todoDraftFromVm({
			id: "t_a",
			kind: "todo",
			title: "Counted",
			status: "active",
			personRefs: [],
			recency: 1,
			createdAt: "fixture",
			deferAt: "2026-07-01T00:00:00",
			recurrence: {
				interval: 1,
				unit: "week",
				anchor: "defer_at",
				end: { afterCount: 5 },
			},
		});
		expect(d.recurEnd).toBe("after");
		expect(d.recurAfterCount).toBe("5");
		expect(d.recurUntilDay).toBe("");
	});

	it("recurAnchorDatePresent gates on the chosen anchor's date", () => {
		expect(
			recurAnchorDatePresent(draft({ recurAnchor: "due_at", dueDay: "" })),
		).toBe(false);
		expect(
			recurAnchorDatePresent(
				draft({ recurAnchor: "due_at", dueDay: "2026-07-01" }),
			),
		).toBe(true);
		expect(
			recurAnchorDatePresent(draft({ recurAnchor: "defer_at", deferDay: "" })),
		).toBe(false);
		expect(
			recurAnchorDatePresent(
				draft({ recurAnchor: "defer_at", deferDay: "2026-07-01" }),
			),
		).toBe(true);
	});
});

describe("entityCodec build — todo update", () => {
	const existing: Todo = {
		id: "t_c1",
		kind: "todo",
		title: "Send schedule",
		status: "active",
		personRefs: [],
		recency: 1,
		createdAt: "fixture",
	};
	// Build an edited draft by spreading the baseline with overrides — exactly how
	// the editor's `set` mutates a single state field.
	const edit = (todo: Todo, over: Partial<TodoDraft>) => {
		const baseline = todoDraftFromVm(todo);
		return buildTodo({
			mode: "update",
			existing: todo,
			baseline,
			draft: { ...baseline, ...over },
		});
	};

	it("diffs the changed title only", () => {
		expect(edit(existing, { title: "Send the new schedule" })).toEqual({
			mutation_kind: "update_todo",
			payload: { todo_id: "t_c1", todo: { title: "Send the new schedule" } },
		});
	});

	it("returns null when nothing changed (no-op)", () => {
		expect(edit(existing, {})).toBeNull();
	});

	it("sends due_at:null (sentinel-null clear) when an existing due date is cleared", () => {
		const withDue: Todo = { ...existing, dueAt: "2026-06-20T00:00:00" };
		expect(edit(withDue, { dueDay: "" })).toEqual({
			mutation_kind: "update_todo",
			payload: { todo_id: "t_c1", todo: { due_at: null } },
		});
	});

	it("sets completed_at and nulls dropped_at on active→completed", () => {
		const params = edit(existing, { status: "completed" });
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo.status).toBe("completed");
		expect(typeof todo.completed_at).toBe("string");
		expect(todo.dropped_at).toBeNull();
	});

	it("nulls both terminal timestamps when leaving a terminal status", () => {
		const completed: Todo = {
			...existing,
			status: "completed",
			completedAt: "2026-06-01T09:00:00",
		};
		expect(edit(completed, { status: "active" })).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: "t_c1",
				todo: { status: "active", completed_at: null, dropped_at: null },
			},
		});
	});

	// CANONICAL RED: a Todo carrying BOTH a waiting_on AND a related ref round-trips
	// through todoDraftFromVm with both kept, and an unchanged edit returns null —
	// the related ref is NOT dropped (the old waiting_on-only read lost it).
	it("round-trips a Todo's full ref set (waiting_on + related); a no-op edit returns null", () => {
		const withBoth: Todo = {
			...existing,
			personRefs: [
				{ personId: "p_a", role: "waiting_on" },
				{ personId: "p_b", role: "related" },
			],
		};
		const baseline = todoDraftFromVm(withBoth);
		expect(baseline.personRefs).toEqual([
			{ personId: "p_a", role: "waiting_on" },
			{ personId: "p_b", role: "related" },
		]);
		// The unchanged draft must produce no write — the related ref survives.
		expect(edit(withBoth, {})).toBeNull();
	});

	it("emits the full new set in set_person_refs when a person is added", () => {
		const withRelated: Todo = {
			...existing,
			personRefs: [{ personId: "p_b", role: "related" }],
		};
		const params = edit(withRelated, {
			personRefs: [
				{ personId: "p_b", role: "related" },
				{ personId: "p_a", role: "waiting_on" },
			],
		});
		expect(params).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: "t_c1",
				set_person_refs: [
					{ person_id: "p_b", role: "related" },
					{ person_id: "p_a", role: "waiting_on" },
				],
			},
		});
	});

	it("carries the new role when a row's role changes (related→waiting_on)", () => {
		const withRelated: Todo = {
			...existing,
			personRefs: [{ personId: "p_a", role: "related" }],
		};
		const params = edit(withRelated, {
			personRefs: [{ personId: "p_a", role: "waiting_on" }],
		});
		const refs = (params?.payload as { set_person_refs: unknown[] })
			.set_person_refs;
		expect(refs).toEqual([{ person_id: "p_a", role: "waiting_on" }]);
	});

	it("drops a removed person from set_person_refs (no remove/add keys)", () => {
		const withTwo: Todo = {
			...existing,
			personRefs: [
				{ personId: "p_a", role: "waiting_on" },
				{ personId: "p_b", role: "related" },
			],
		};
		const params = edit(withTwo, {
			personRefs: [{ personId: "p_a", role: "waiting_on" }],
		});
		const payload = params?.payload as Record<string, unknown>;
		expect(payload.set_person_refs).toEqual([
			{ person_id: "p_a", role: "waiting_on" },
		]);
		expect(JSON.stringify(payload.set_person_refs)).not.toContain("p_b");
		expect(payload).not.toHaveProperty("remove_person_ids");
		expect(payload).not.toHaveProperty("add_person_refs");
	});

	it("emits set_person_refs:[] when all refs are cleared", () => {
		const withOne: Todo = {
			...existing,
			personRefs: [{ personId: "p_a", role: "waiting_on" }],
		};
		expect(edit(withOne, { personRefs: [] })).toEqual({
			mutation_kind: "update_todo",
			payload: { todo_id: "t_c1", set_person_refs: [] },
		});
	});

	it("omits the set_person_refs key when the ref set is unchanged", () => {
		const withOne: Todo = {
			...existing,
			personRefs: [{ personId: "p_a", role: "waiting_on" }],
		};
		const params = edit(withOne, { title: "Renamed" });
		const payload = params?.payload as Record<string, unknown>;
		expect(payload).not.toHaveProperty("set_person_refs");
		expect(payload.todo).toEqual({ title: "Renamed" });
	});

	it("omits set_person_refs when the same refs are merely reordered (order-insensitive)", () => {
		const withTwo: Todo = {
			...existing,
			personRefs: [
				{ personId: "p_a", role: "waiting_on" },
				{ personId: "p_b", role: "related" },
			],
		};
		// Same set, reversed order in the draft → no change.
		expect(
			edit(withTwo, {
				personRefs: [
					{ personId: "p_b", role: "related" },
					{ personId: "p_a", role: "waiting_on" },
				],
			}),
		).toBeNull();
	});

	const recurring: Todo = {
		...existing,
		deferAt: "2026-07-01T00:00:00",
		recurrence: {
			interval: 1,
			unit: "week",
			anchor: "defer_at",
		},
	};

	it("emits the whole new rule when the interval changes", () => {
		expect(edit(recurring, { recurInterval: "2" })).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: "t_c1",
				todo: {
					recurrence: {
						interval: 2,
						unit: "week",
						anchor: "defer_at",
					},
				},
			},
		});
	});

	it("emits recurrence:null when Repeats is toggled off", () => {
		expect(edit(recurring, { recurs: false })).toEqual({
			mutation_kind: "update_todo",
			payload: { todo_id: "t_c1", todo: { recurrence: null } },
		});
	});

	it("omits the recurrence key when the rule is unchanged", () => {
		const params = edit(recurring, { title: "Send schedule v2" });
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo).toEqual({ title: "Send schedule v2" });
		expect(todo).not.toHaveProperty("recurrence");
	});

	// Anchor gate (update side): toggling Repeats ON without the anchor's date keeps
	// recurActive false on both prev and next, so the rule diff is null↔null — no
	// recurrence key, and certainly no anchorless rule Core would reject.
	it("omits recurrence when Repeats is toggled on but the anchor date is absent", () => {
		const params = edit(existing, { recurs: true, recurAnchor: "due_at" });
		expect(params).toBeNull();
	});

	it("round-trips the stashed end condition through a common-path edit", () => {
		const fullyLoaded: Todo = {
			...existing,
			deferAt: "2026-07-01T00:00:00",
			recurrence: {
				interval: 1,
				unit: "week",
				anchor: "defer_at",
				end: { afterCount: 10 },
			},
		};
		expect(edit(fullyLoaded, { recurInterval: "3" })).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: "t_c1",
				todo: {
					recurrence: {
						interval: 3,
						unit: "week",
						anchor: "defer_at",
						end: { after_count: 10 },
					},
				},
			},
		});
	});

	const recurringUntil: Todo = {
		...existing,
		deferAt: "2026-07-01T00:00:00",
		recurrence: {
			interval: 1,
			unit: "week",
			anchor: "defer_at",
			end: { until: "2026-12-31T00:00:00" },
		},
	};

	// Changing the End choice rebuilds the whole rule (recurrence diffs as one object).
	it("emits the whole rule with the new end when End switches until→after", () => {
		expect(
			edit(recurringUntil, { recurEnd: "after", recurAfterCount: "3" }),
		).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: "t_c1",
				todo: {
					recurrence: {
						interval: 1,
						unit: "week",
						anchor: "defer_at",
						end: { after_count: 3 },
					},
				},
			},
		});
	});

	// Clearing End to `never` drops `end` from the emitted rule (still a rule, just
	// unbounded) — distinct from toggling Repeats off, which sends recurrence:null.
	it("drops `end` when the End choice is cleared to never", () => {
		expect(edit(recurringUntil, { recurEnd: "never" })).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: "t_c1",
				todo: {
					recurrence: {
						interval: 1,
						unit: "week",
						anchor: "defer_at",
					},
				},
			},
		});
	});

	// A stored NON-MIDNIGHT `until` (an agent can author one — Core's until compare
	// is a full wall-clock string) must round-trip VERBATIM through an unrelated
	// edit; the editor only edits the day, so an untouched day must not silently
	// fold the bound to midnight and (since until is inclusive) drop the last
	// occurrence. Pins the recurUntilStored verbatim-re-emit branch.
	const recurringUntilNonMidnight: Todo = {
		...existing,
		deferAt: "2026-07-01T00:00:00",
		recurrence: {
			interval: 1,
			unit: "week",
			anchor: "defer_at",
			end: { until: "2026-12-31T23:59:59" },
		},
	};

	it("round-trips a non-midnight `until` verbatim through an unrelated edit", () => {
		expect(
			edit(recurringUntilNonMidnight, { title: "Renamed but still bounded" }),
		).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: "t_c1",
				// Only the title diffs; the untouched recurrence is NOT re-emitted
				// (rule unchanged), so the stored until is preserved by omission.
				todo: { title: "Renamed but still bounded" },
			},
		});
	});

	it("folds `until` to midnight only when the day actually changes", () => {
		expect(
			edit(recurringUntilNonMidnight, { recurUntilDay: "2027-01-15" }),
		).toEqual({
			mutation_kind: "update_todo",
			payload: {
				todo_id: "t_c1",
				todo: {
					recurrence: {
						interval: 1,
						unit: "week",
						anchor: "defer_at",
						end: { until: "2027-01-15T00:00:00" },
					},
				},
			},
		});
	});

	// Editing an unrelated field (interval) while the day is untouched re-emits the
	// whole rule — and the stored non-midnight until must survive verbatim in it.
	it("preserves the stored non-midnight `until` when another rule field changes", () => {
		const params = edit(recurringUntilNonMidnight, { recurInterval: "2" });
		const todo = (params?.payload as { todo: Record<string, unknown> }).todo;
		expect(todo.recurrence).toEqual({
			interval: 2,
			unit: "week",
			anchor: "defer_at",
			end: { until: "2026-12-31T23:59:59" },
		});
	});
});

// The preview-params gate (#227 review-fix): the editor only previews a bounded
// series whose end (and interval) are COMPLETE, so the preview can't show a
// "next occurrence" for a rule buildRecurrence would emit unbounded mid-entry.
describe("buildRecurrencePreviewParams gate", () => {
	const draft = (over: Partial<TodoDraft> = {}): TodoDraft => ({
		...todoDraftFromVm(undefined),
		deferDay: "2026-07-01",
		recurs: true,
		recurAnchor: "defer_at",
		...over,
	});

	it("returns null when End is never (unbounded — nothing to preview)", () => {
		expect(
			buildRecurrencePreviewParams(draft({ recurEnd: "never" })),
		).toBeNull();
	});

	it("returns null for End=after with a blank or non-positive count", () => {
		expect(
			buildRecurrencePreviewParams(
				draft({ recurEnd: "after", recurAfterCount: "" }),
			),
		).toBeNull();
		expect(
			buildRecurrencePreviewParams(
				draft({ recurEnd: "after", recurAfterCount: "0" }),
			),
		).toBeNull();
	});

	it("returns null for End=until with a blank date", () => {
		expect(
			buildRecurrencePreviewParams(
				draft({ recurEnd: "until", recurUntilDay: "" }),
			),
		).toBeNull();
	});

	it("returns null when the interval is blank or non-positive", () => {
		expect(
			buildRecurrencePreviewParams(
				draft({ recurEnd: "after", recurAfterCount: "5", recurInterval: "" }),
			),
		).toBeNull();
	});

	it("returns params with the folded rule once the end is complete", () => {
		expect(
			buildRecurrencePreviewParams(
				draft({ recurEnd: "after", recurAfterCount: "5" }),
			),
		).toEqual({
			recurrence: {
				interval: 1,
				unit: "week",
				anchor: "defer_at",
				end: { after_count: 5 },
			},
			defer_at: "2026-07-01T00:00:00",
		});
	});
});

describe("entityCodec build — person create", () => {
	const draft = (over: Partial<PersonDraft> = {}): PersonDraft => ({
		...personDraftFromVm(undefined),
		...over,
	});

	it("emits create_person with only the filled fields (name-only)", () => {
		expect(
			buildPerson({ mode: "create", draft: draft({ name: "Bob" }) }),
		).toEqual({
			mutation_kind: "create_person",
			payload: { name: "Bob" },
		});
	});

	it("includes note and aliases as a plain string[] when given", () => {
		expect(
			buildPerson({
				mode: "create",
				draft: draft({
					name: "Bob",
					note: "Met at the daycare",
					aliases: "Bobby, Rob",
				}),
			}),
		).toEqual({
			mutation_kind: "create_person",
			payload: {
				name: "Bob",
				note: "Met at the daycare",
				aliases: ["Bobby", "Rob"],
			},
		});
	});
});

describe("entityCodec build — person update", () => {
	const existing: Person = {
		id: "p_e1",
		kind: "person",
		name: "Alice",
		recency: 1,
		createdAt: "fixture",
	};
	const edit = (person: Person, over: Partial<PersonDraft>) => {
		const baseline = personDraftFromVm(person);
		return buildPerson({
			mode: "update",
			existing: person,
			baseline,
			draft: { ...baseline, ...over },
		});
	};

	it("replays note + aliases when only the name changes (full-replace)", () => {
		const withOptionals: Person = {
			...existing,
			note: "Met at the daycare",
			aliases: ["Ally", "A."],
		};
		expect(edit(withOptionals, { name: "Alice Smith" })).toEqual({
			mutation_kind: "update_person",
			payload: {
				entity_id: "p_e1",
				name: "Alice Smith",
				note: "Met at the daycare",
				aliases: ["Ally", "A."],
			},
		});
	});

	it("returns null when nothing changed (no-op)", () => {
		expect(edit(existing, {})).toBeNull();
	});

	it("omits cleared optionals from the full doc (omit ≡ null), name still present", () => {
		const withOptionals: Person = {
			...existing,
			note: "Old note",
			aliases: ["Ally"],
		};
		expect(edit(withOptionals, { note: "", aliases: "" })).toEqual({
			mutation_kind: "update_person",
			payload: { entity_id: "p_e1", name: "Alice" },
		});
	});
});

describe("entityCodec build — media create", () => {
	const draft = (over: Partial<MediaDraft> = {}): MediaDraft => ({
		...mediaDraftFromVm(undefined),
		...over,
	});

	it("emits create_media with the required title/medium/state (non-terminal omits rating/finished)", () => {
		expect(
			buildMedia({
				mode: "create",
				draft: draft({ title: "Dune", medium: "book", state: "consuming" }),
			}),
		).toEqual({
			mutation_kind: "create_media",
			payload: { title: "Dune", medium: "book", state: "consuming" },
		});
	});

	it("includes rating/finished_at on a terminal state, and url/note/dedup tags", () => {
		expect(
			buildMedia({
				mode: "create",
				draft: draft({
					title: "The Matrix",
					medium: "movie",
					state: "done",
					rating: "5",
					finishedDay: "2026-06-20",
					url: "https://example.com",
					note: "rewatch",
					tags: "scifi, action, scifi",
				}),
			}),
		).toEqual({
			mutation_kind: "create_media",
			payload: {
				title: "The Matrix",
				medium: "movie",
				state: "done",
				rating: 5,
				finished_at: "2026-06-20T00:00:00",
				url: "https://example.com",
				note: "rewatch",
				tags: ["scifi", "action"],
			},
		});
	});

	it("omits rating/finished_at when the state is non-terminal even if the draft holds them", () => {
		// Core REJECTS rating/finished on a non-terminal state — the build must drop
		// the stale values rather than emit a payload Core would reject.
		expect(
			buildMedia({
				mode: "create",
				draft: draft({
					title: "Inception",
					medium: "movie",
					state: "backlog",
					rating: "4",
					finishedDay: "2026-06-20",
				}),
			}),
		).toEqual({
			mutation_kind: "create_media",
			payload: { title: "Inception", medium: "movie", state: "backlog" },
		});
	});

	// The media round-trip is the ONLY guard on the ungated media schemas (no Rust
	// fixture) — so prove the built payload decodes against the shipped
	// @inkstone/protocol schema. Create/update have NO sentinel-null, so a
	// schema-decode is valid here (unlike todo's update).
	it("the built create payload decodes against createMedia", () => {
		const params = buildMedia({
			mode: "create",
			draft: draft({
				title: "Dune",
				medium: "book",
				state: "done",
				rating: "5",
				finishedDay: "2026-06-20",
				url: "https://example.com",
				note: "reread",
				tags: "scifi",
			}),
		});
		expect(params).not.toBeNull();
		expect(
			S.decodeUnknownSync(createMedia)(
				(params as { payload: unknown }).payload,
			),
		).toEqual((params as { payload: unknown }).payload);
	});
});

describe("entityCodec build — media update", () => {
	const existing: Media = {
		id: "m_e1",
		kind: "media",
		title: "Dune",
		medium: "book",
		state: "backlog",
		recency: 1,
		createdAt: "fixture",
	};
	const edit = (media: Media, over: Partial<MediaDraft>) => {
		const baseline = mediaDraftFromVm(media);
		return buildMedia({
			mode: "update",
			existing: media,
			baseline,
			draft: { ...baseline, ...over },
		});
	};

	it("replays medium + state when only the title changes (full-replace)", () => {
		expect(edit(existing, { title: "Dune (Messiah)" })).toEqual({
			mutation_kind: "update_media",
			payload: {
				entity_id: "m_e1",
				title: "Dune (Messiah)",
				medium: "book",
				state: "backlog",
			},
		});
	});

	it("returns null when nothing changed (no-op)", () => {
		expect(edit(existing, {})).toBeNull();
	});

	it("omits a cleared rating from the full doc (omit ≡ null), terminal state present", () => {
		const done: Media = {
			...existing,
			state: "done",
			rating: 5,
			finishedAt: "2026-06-20T00:00:00",
		};
		expect(edit(done, { rating: "" })).toEqual({
			mutation_kind: "update_media",
			payload: {
				entity_id: "m_e1",
				title: "Dune",
				medium: "book",
				state: "done",
				finished_at: "2026-06-20T00:00:00",
			},
		});
	});

	it("drops rating/finished when the state moves off terminal", () => {
		const done: Media = {
			...existing,
			state: "done",
			rating: 5,
			finishedAt: "2026-06-20T00:00:00",
		};
		expect(edit(done, { state: "consuming" })).toEqual({
			mutation_kind: "update_media",
			payload: {
				entity_id: "m_e1",
				title: "Dune",
				medium: "book",
				state: "consuming",
			},
		});
	});

	it("the built update payload decodes against updateMedia", () => {
		const params = edit(existing, { title: "Dune (Messiah)" });
		expect(params).not.toBeNull();
		expect(
			S.decodeUnknownSync(updateMedia)(
				(params as { payload: unknown }).payload,
			),
		).toEqual((params as { payload: unknown }).payload);
	});
});

describe("entityCodec build — project create", () => {
	const draft = (over: Partial<ProjectDraft> = {}): ProjectDraft => ({
		...projectDraftFromVm(undefined),
		...over,
	});

	it("emits create_project with only the filled fields (no review_every; active omitted)", () => {
		expect(
			buildProject({ mode: "create", draft: draft({ name: "Garden" }) }),
		).toEqual({
			mutation_kind: "create_project",
			payload: { name: "Garden" },
		});
	});

	it("includes outcome and note when given", () => {
		expect(
			buildProject({
				mode: "create",
				draft: draft({
					name: "Garden",
					outcome: "Beds planted",
					note: "Spring project",
				}),
			}),
		).toEqual({
			mutation_kind: "create_project",
			payload: {
				name: "Garden",
				outcome: "Beds planted",
				note: "Spring project",
			},
		});
	});

	it("stamps the matching terminal timestamp on a non-active status (completed)", () => {
		const params = buildProject({
			mode: "create",
			draft: draft({ name: "Done", status: "completed" }),
		});
		const payload = (params as { payload: Record<string, unknown> }).payload;
		expect(payload.status).toBe("completed");
		expect(typeof payload.completed_at).toBe("string");
		expect(payload).not.toHaveProperty("dropped_at");
	});
});

describe("entityCodec build — project update", () => {
	// The complete stored data the editor replays into a full-document replace —
	// carries the server-managed review ritual the form never renders.
	const existing: Project = {
		id: "proj_e1",
		kind: "project",
		name: "Daycare move",
		status: "active",
		recency: 1,
		createdAt: "fixture",
		data: {
			name: "Daycare move",
			status: "active",
			review_every: "P1W",
			next_review_at: "2026-06-21T20:00:00",
		},
	};
	const edit = (project: Project, over: Partial<ProjectDraft>) => {
		const baseline = projectDraftFromVm(project);
		return buildProject({
			mode: "update",
			existing: project,
			baseline,
			draft: { ...baseline, ...over },
		});
	};

	it("replays the full verbatim stored document when only outcome changes (review_every/next_review_at survive)", () => {
		expect(edit(existing, { outcome: "Moved in" })).toEqual({
			mutation_kind: "update_project",
			payload: {
				entity_id: "proj_e1",
				name: "Daycare move",
				status: "active",
				review_every: "P1W",
				next_review_at: "2026-06-21T20:00:00",
				outcome: "Moved in",
			},
		});
	});

	it("returns null when nothing changed (no-op)", () => {
		expect(edit(existing, {})).toBeNull();
	});

	it("stamps completed_at and drops dropped_at on active→completed (status change)", () => {
		const params = edit(existing, { status: "completed" });
		const payload = (params as { payload: Record<string, unknown> }).payload;
		expect(payload.status).toBe("completed");
		expect(typeof payload.completed_at).toBe("string");
		expect("dropped_at" in payload).toBe(false);
		// Review ritual survives.
		expect(payload.review_every).toBe("P1W");
	});

	it("clears terminal timestamps when leaving a terminal status", () => {
		const completed: Project = {
			...existing,
			status: "completed",
			data: {
				...existing.data,
				status: "completed",
				completed_at: "2026-06-01T12:00:00",
			},
		};
		const params = edit(completed, { status: "active" });
		const payload = (params as { payload: Record<string, unknown> }).payload;
		expect(payload.status).toBe("active");
		expect("completed_at" in payload).toBe(false);
		expect("dropped_at" in payload).toBe(false);
		expect(payload.review_every).toBe("P1W");
	});

	it("preserves the stored completed_at when status is unchanged", () => {
		const completed: Project = {
			...existing,
			status: "completed",
			outcome: "Old goal",
			data: {
				...existing.data,
				status: "completed",
				outcome: "Old goal",
				completed_at: "2026-06-01T12:00:00",
			},
		};
		const params = edit(completed, { outcome: "Moved in" });
		const payload = (params as { payload: Record<string, unknown> }).payload;
		expect(payload.status).toBe("completed");
		expect(payload.outcome).toBe("Moved in");
		// The original completion timestamp survives — NOT re-stamped.
		expect(payload.completed_at).toBe("2026-06-01T12:00:00");
	});

	it("drops a cleared optional (outcome) from the full doc; the rest survives", () => {
		const withOutcome: Project = {
			...existing,
			outcome: "Old goal",
			data: { ...existing.data, outcome: "Old goal" },
		};
		const params = edit(withOutcome, { outcome: "" });
		const payload = (params as { payload: Record<string, unknown> }).payload;
		expect("outcome" in payload).toBe(false);
		expect(payload.name).toBe("Daycare move");
		expect(payload.review_every).toBe("P1W");
	});
});

describe("entityCodec build — journal_entry create", () => {
	it("emits create_journal_entry with occurred_at + text body, dropping empty text segments", () => {
		const draft: JournalDraft = {
			occurredAt: "2026-06-12T09:00",
			endedAt: "",
			body: [
				{ type: "text", text: "Quick standup notes." },
				{ type: "text", text: "   " },
			],
		};
		expect(buildJournalEntry({ mode: "create", draft })).toEqual({
			mutation_kind: "create_journal_entry",
			payload: {
				occurred_at: "2026-06-12T09:00:00",
				body: [{ type: "text", text: "Quick standup notes." }],
			},
		});
	});

	it("includes ended_at when an end time is set", () => {
		const draft: JournalDraft = {
			occurredAt: "2026-06-12T09:00",
			endedAt: "2026-06-12T09:30",
			body: [{ type: "text", text: "Pairing session." }],
		};
		expect(buildJournalEntry({ mode: "create", draft })).toEqual({
			mutation_kind: "create_journal_entry",
			payload: {
				occurred_at: "2026-06-12T09:00:00",
				ended_at: "2026-06-12T09:30:00",
				body: [{ type: "text", text: "Pairing session." }],
			},
		});
	});
});

describe("entityCodec build — journal_entry update", () => {
	const REF_A = "01900000-0000-7000-8000-0000000000a1";
	const REF_B = "01900000-0000-7000-8000-0000000000a2";
	const existing: JournalEntry = {
		id: "je_e1",
		kind: "journal_entry",
		occurredAt: "2026-06-10T10:30:00",
		endedAt: "2026-06-10T10:45:00",
		body: [
			{ type: "text", text: "Spoke with " },
			{ type: "entity_ref", refId: REF_A, targetTitle: "Alice" },
			{ type: "text", text: " about " },
			{ type: "entity_ref", refId: REF_B, targetTitle: "Daycare move" },
			{ type: "text", text: " plans." },
		],
		recency: 1,
		createdAt: "fixture",
	};

	it("keeps existing chips as snake_case ref_id nodes and preserves occurred_at/ended_at (full replace)", () => {
		const draft = journalDraftFromVm(existing);
		// Edit only the trailing text segment; keep both chips.
		draft.body[4] = { type: "text", text: " plans for next week." };
		expect(buildJournalEntry({ mode: "update", existing, draft })).toEqual({
			mutation_kind: "update_journal_entry",
			payload: {
				entity_id: "je_e1",
				occurred_at: "2026-06-10T10:30:00",
				ended_at: "2026-06-10T10:45:00",
				body: [
					{ type: "text", text: "Spoke with " },
					{ type: "entity_ref", ref_id: REF_A },
					{ type: "text", text: " about " },
					{ type: "entity_ref", ref_id: REF_B },
					{ type: "text", text: " plans for next week." },
				],
			},
		});
	});

	it("omits a removed chip from the emitted body", () => {
		const draft = journalDraftFromVm(existing);
		// Remove the first chip (REF_A at index 1).
		draft.body = draft.body.filter((_, i) => i !== 1);
		const params = buildJournalEntry({ mode: "update", existing, draft });
		const body = (params.payload as { body: Array<{ type: string }> }).body;
		const refNodes = body.filter((n) => n.type === "entity_ref");
		expect(refNodes).toEqual([{ type: "entity_ref", ref_id: REF_B }]);
		expect(JSON.stringify(body)).not.toContain(REF_A);
		expect(JSON.stringify(body)).not.toContain("refId");
	});

	it("preserves stored occurred_at seconds on a body-only edit (minute-prefix unchanged)", () => {
		const withSeconds: JournalEntry = {
			...existing,
			occurredAt: "2026-06-10T10:30:45",
			endedAt: undefined,
			body: [{ type: "text", text: "Standup." }],
		};
		const draft = journalDraftFromVm(withSeconds);
		draft.body[0] = { type: "text", text: "Standup notes." };
		const params = buildJournalEntry({
			mode: "update",
			existing: withSeconds,
			draft,
		});
		const payload = params.payload as Record<string, unknown>;
		expect(payload.occurred_at).toBe("2026-06-10T10:30:45");
		expect("ended_at" in payload).toBe(false);
	});

	it("drops ended_at when the end time is cleared", () => {
		const draft = journalDraftFromVm(existing);
		draft.endedAt = "";
		const params = buildJournalEntry({ mode: "update", existing, draft });
		const payload = params.payload as Record<string, unknown>;
		expect("ended_at" in payload).toBe(false);
		expect(payload.occurred_at).toBe("2026-06-10T10:30:00");
	});

	it("journalScalarsDiffer is true iff occurred/ended changed", () => {
		const same = journalDraftFromVm(existing);
		expect(journalScalarsDiffer(existing, same)).toBe(false);

		const occurredEdit = { ...same, occurredAt: "2026-06-11T08:15" };
		expect(journalScalarsDiffer(existing, occurredEdit)).toBe(true);

		const endedCleared = { ...same, endedAt: "" };
		expect(journalScalarsDiffer(existing, endedCleared)).toBe(true);
	});
});

describe("entityCodec build — journal_entry reference", () => {
	const textOnly: JournalEntry = {
		id: "je_e2",
		kind: "journal_entry",
		occurredAt: "2026-06-10T10:30:00",
		endedAt: undefined,
		body: [{ type: "text", text: "Standup notes." }],
		recency: 1,
		createdAt: "fixture",
	};

	it("builds a reference with exactly one bare placeholder + text nodes + source/target ids + label_snapshot", () => {
		const draft = journalDraftFromVm(textOnly);
		// Stage ONE new chip (a bare placeholder carrying the picked target).
		draft.body = [
			...draft.body,
			{ type: "entity_ref", newTargetId: "person_bob", label: "Bob" },
		];
		const chip = stagedNewChip(draft.body);
		expect(chip).toBeDefined();
		const params = buildJournalReference(
			textOnly,
			draft,
			// biome-ignore lint/style/noNonNullAssertion: asserted defined above.
			chip!,
		);
		expect(params.mutation_kind).toBe(
			"reference_existing_entity_from_journal_entry",
		);
		const payload = params.payload as {
			source_entity_id: string;
			target_entity_id: string;
			label_snapshot?: string;
			body: Array<{ type: string }>;
		};
		expect(payload.source_entity_id).toBe(textOnly.id);
		expect(payload.target_entity_id).toBe("person_bob");
		expect(payload.label_snapshot).toBe("Bob");
		expect(payload.body).toEqual([
			{ type: "text", text: "Standup notes." },
			{ type: "entity_ref" },
		]);
		expect(JSON.stringify(payload.body)).not.toContain("ref_id");
	});
});
