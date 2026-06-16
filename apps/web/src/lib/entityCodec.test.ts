import { describe, expect, it } from "vitest";
import {
	type LiveEntityRow,
	parseBookmark,
	parseJournalEntry,
	parsePerson,
	parseProject,
	parseTodo,
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
						schedule: "regular",
						anchor: "defer_at",
						catch_up: true,
						only_on: { weekdays: ["mon", "wed"], month_days: [1, 15] },
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
			schedule: "regular",
			anchor: "defer_at",
			catchUp: true,
			onlyOn: { weekdays: ["mon", "wed"], monthDays: [1, 15] },
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

	it("coerces an unknown status to active", () => {
		expect(parseTodo(row({ status: "bogus" })).status).toBe("active");
	});

	it("drops a malformed recurrence rule (missing unit) → undefined", () => {
		expect(
			parseTodo(row({ recurrence: { interval: 2 } })).recurrence,
		).toBeUndefined();
	});

	it("maps an until end condition with month_days", () => {
		const vm = parseTodo(
			row({
				recurrence: {
					interval: 1,
					unit: "month",
					schedule: "from_completion",
					anchor: "due_at",
					only_on: { month_days: [1, 15] },
					end: { until: "2027-01-01T00:00:00" },
				},
			}),
		);
		expect(vm.recurrence).toEqual({
			interval: 1,
			unit: "month",
			schedule: "from_completion",
			anchor: "due_at",
			onlyOn: { monthDays: [1, 15] },
			end: { until: "2027-01-01T00:00:00" },
		});
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

describe("entityCodec parse — bookmark", () => {
	const row = (data: unknown): LiveEntityRow => ({
		id: "b_1",
		data,
		created_at: 5000,
	});

	it("parses a full row", () => {
		const vm = parseBookmark(
			row({
				title: "Effect docs",
				url: "https://effect.website",
				note: "schemas",
				tags: ["ts", "effect"],
			}),
		);
		expect(vm.id).toBe("b_1");
		expect(vm.kind).toBe("bookmark");
		expect(vm.title).toBe("Effect docs");
		expect(vm.url).toBe("https://effect.website");
		expect(vm.note).toBe("schemas");
		expect(vm.tags).toEqual(["ts", "effect"]);
		expect(vm.recency).toBe(5000);
	});

	it("defaults the title to Untitled on a sparse row", () => {
		const vm = parseBookmark(row({}));
		expect(vm.title).toBe("Untitled");
		expect(vm.url).toBeUndefined();
		expect(vm.tags).toBeUndefined();
	});

	it("filters non-string tags and yields undefined when none remain", () => {
		expect(parseBookmark(row({ tags: ["a", 1, "b"] })).tags).toEqual([
			"a",
			"b",
		]);
		expect(parseBookmark(row({ tags: [1, 2] })).tags).toBeUndefined();
		expect(parseBookmark(row({ tags: [] })).tags).toBeUndefined();
	});
});
