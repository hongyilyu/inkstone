// The promoted payload-schema registry (ADR-0009): the 15 agent-proposable wire
// kinds moved here from `tests/contract`, plus the 3 ungated media schemas
// (ADR-0059) the Web codec consumes. This test pins the promotion (the registry
// is intact and decodes) and guards the ungated boundary (media is NOT in
// `schemas`, so it stays out of the parity lock). The parity/completeness gates
// in `tests/contract` — now sourcing the registry from here — remain the proof
// the move is byte-for-byte behavior-preserving.

import { Schema as S } from "effect";
import { describe, expect, it } from "vitest";
import {
	applyIntentGraph,
	createMedia,
	deleteMedia,
	schemas,
	updateMedia,
	type WireKind,
} from "../src/index.js";

/** The 15 agent-proposable wire kinds (mirrors `completeness.test`'s lock). */
const WIRE_KINDS = [
	"create_journal_entry",
	"update_journal_entry",
	"delete_journal_entry",
	"reference_existing_entity_from_journal_entry",
	"create_person",
	"update_person",
	"delete_person",
	"create_project",
	"update_project",
	"delete_project",
	"create_todo",
	"update_todo",
	"delete_todo",
	"apply_intent_graph",
	"record_observations",
] as const;

const sorted = (kinds: readonly string[]): string[] => [...kinds].sort();

describe("promoted payload registry", () => {
	it("holds exactly the 15 wire kinds", () => {
		expect(sorted(Object.keys(schemas))).toStrictEqual(sorted(WIRE_KINDS));
	});

	it("decodes a valid create_todo payload", () => {
		const payload = {
			todo: { title: "buy milk", status: "active" },
		};
		expect(
			S.decodeUnknownSync(schemas.create_todo as S.Schema<unknown, unknown>)(
				payload,
			),
		).toEqual(payload);
	});
});

describe("record_observations payload (ADR-0053)", () => {
	it("decodes a batch with evidence", () => {
		const payload = {
			observations: [
				{
					schema_key: "bodyweight",
					occurred_at: "2026-06-02T07:30:00",
					values: { kg: 72.4 },
					note: "after breakfast",
				},
				{
					schema_key: "habit.checkin",
					occurred_at: "2026-06-03T07:30:00",
					values: {
						habit_id: "0190d3c1-0000-7000-8000-000000000004",
						state: "done",
					},
				},
			],
			evidence: {
				journal_entry_id: "0190d3c1-0000-7000-8000-000000000001",
			},
		};
		expect(
			S.decodeUnknownSync(
				schemas.record_observations as S.Schema<unknown, unknown>,
			)(payload),
		).toEqual(payload);
	});

	it("decodes a nutrition.intake observation", () => {
		const payload = {
			observations: [
				{
					schema_key: "nutrition.intake",
					occurred_at: "2026-06-04T12:30:00",
					values: {
						kcal: 450,
						protein_g: 30,
						carbs_g: 50,
						fat_g: 12,
						label: "lunch",
					},
				},
			],
		};
		expect(
			S.decodeUnknownSync(
				schemas.record_observations as S.Schema<unknown, unknown>,
			)(payload),
		).toEqual(payload);
	});

	it("rejects malformed or two-source evidence", () => {
		const base = {
			observations: [
				{
					schema_key: "bodyweight",
					occurred_at: "2026-06-02T07:30:00",
					values: { kg: 72.4 },
				},
			],
		};
		const schema = schemas.record_observations as S.Schema<unknown, unknown>;
		expect(() =>
			S.decodeUnknownSync(schema)({
				...base,
				evidence: { journal_entry_id: "not-a-uuid" },
			}),
		).toThrow();
		expect(() =>
			S.decodeUnknownSync(schema)({
				...base,
				evidence: {
					journal_entry_id: "0190d3c1-0000-7000-8000-000000000001",
					message_id: "0190d3c1-0000-7000-8000-000000000002",
				},
			}),
		).toThrow();
	});

	it("rejects unknown observation schemas and schema-specific bad values", () => {
		const schema = schemas.record_observations as S.Schema<unknown, unknown>;
		expect(() =>
			S.decodeUnknownSync(schema)({
				observations: [
					{
						schema_key: "sleep.session",
						occurred_at: "2026-06-02T07:30:00",
						values: { kcal: 450 },
					},
				],
			}),
		).toThrow();
		expect(() =>
			S.decodeUnknownSync(schema)({
				observations: [
					{
						schema_key: "bodyweight",
						occurred_at: "2026-06-02T07:30:00",
						values: { lbs: 160 },
					},
				],
			}),
		).toThrow();
		expect(() =>
			S.decodeUnknownSync(schema)({
				observations: [
					{
						schema_key: "habit.checkin",
						occurred_at: "2026-06-02T07:30:00",
						values: {
							habit_id: "not-a-uuid",
							state: "done",
						},
					},
				],
			}),
		).toThrow();
	});
});

describe("apply_intent_graph payload (ADR-0042)", () => {
	it("decodes a journal-anchored graph with entities + links", () => {
		const payload = {
			journal_entry: {
				handle: "@je",
				occurred_at: "2026-06-10T10:30:00",
				body: [
					{ type: "text", text: "Talked to " },
					{ type: "entity_ref", target: "@morris" },
				],
			},
			entities: [
				{ handle: "@morris", type: "person", name: "Morris" },
				{
					handle: "@leadads",
					type: "project",
					name: "Lead Ads",
					existing_id: "00000000-0000-4000-8000-000000000000",
				},
				{ handle: "@rodeo", type: "todo", title: "Figure out the Rodeo side" },
			],
			links: [
				{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
				{ kind: "todo_person", from: "@rodeo", to: "@morris", role: "related" },
				{ kind: "journal_ref", from: "@je", to: "@morris" },
			],
		};
		expect(S.decodeUnknownSync(applyIntentGraph)(payload)).toEqual(payload);
		expect(
			S.decodeUnknownSync(
				schemas.apply_intent_graph as S.Schema<unknown, unknown>,
			)(payload),
		).toEqual(payload);
	});

	it("decodes a direct-capture graph (no journal_entry)", () => {
		const payload = {
			entities: [{ handle: "@alice", type: "person", name: "Alice" }],
			links: [],
		};
		expect(S.decodeUnknownSync(applyIntentGraph)(payload)).toEqual(payload);
	});

	it("rejects an entities array with a non-person/project/todo node type", () => {
		expect(() =>
			S.decodeUnknownSync(applyIntentGraph)({
				entities: [{ handle: "@x", type: "bookmark", title: "x" }],
				links: [],
			}),
		).toThrow();
	});
});

describe("ungated media schemas (NOT in the proposable registry)", () => {
	it("decodes a valid create_media payload", () => {
		const payload = {
			title: "Dune",
			medium: "movie",
			state: "done",
			rating: 5,
			url: "https://example.com/dune",
		};
		expect(S.decodeUnknownSync(createMedia)(payload)).toEqual(payload);
	});

	it("exports updateMedia and deleteMedia", () => {
		expect(
			S.decodeUnknownSync(updateMedia)({
				entity_id: "m1",
				title: "renamed",
				medium: "book",
				state: "backlog",
			}),
		).toEqual({
			entity_id: "m1",
			title: "renamed",
			medium: "book",
			state: "backlog",
		});
		expect(S.decodeUnknownSync(deleteMedia)({ entity_id: "m1" })).toEqual({
			entity_id: "m1",
		});
	});

	it("validates the medium/state enums (rejects out-of-domain values)", () => {
		// A valid Media object (in-domain medium + state) decodes.
		const valid = { title: "1984", medium: "book", state: "consuming" };
		expect(S.decodeUnknownSync(createMedia)(valid)).toEqual(valid);
		// An out-of-domain `medium` is rejected by the S.Literal enum.
		expect(() =>
			S.decodeUnknownSync(createMedia)({
				title: "x",
				medium: "podcast",
				state: "backlog",
			}),
		).toThrow();
		// An out-of-domain `state` is rejected by the S.Literal enum.
		expect(() =>
			S.decodeUnknownSync(createMedia)({
				title: "x",
				medium: "book",
				state: "reading",
			}),
		).toThrow();
	});

	it("keeps the media kinds OUT of `schemas` (the ungated boundary)", () => {
		const keys = Object.keys(schemas) as WireKind[];
		expect(keys).not.toContain("create_media");
		expect(keys).not.toContain("update_media");
		expect(keys).not.toContain("delete_media");
	});
});
