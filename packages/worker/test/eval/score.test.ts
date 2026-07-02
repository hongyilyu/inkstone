import { describe, expect, it } from "vitest";
import {
	f1,
	normalize,
	projectBaseName,
	scoreProposal,
} from "../../eval/score.js";
import type { ExpectedProposal, PredictedProposal } from "../../eval/types.js";

// A valid apply_intent_graph payload (mirrors packages/protocol/src/payloads.test.ts):
// optional journal_entry, >=1 entity nodes, links array.
const perfectIntentGraph: PredictedProposal = {
	mutation_kind: "apply_intent_graph",
	payload: {
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
			{ handle: "@leadads", type: "project", name: "Lead Ads" },
			{ handle: "@rodeo", type: "todo", title: "Figure out the Rodeo side" },
		],
		links: [
			{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
			{ kind: "todo_person", from: "@rodeo", to: "@morris", role: "related" },
			{ kind: "journal_ref", from: "@je", to: "@morris" },
		],
	},
};

// The expected proposal the perfect prediction should align to perfectly.
const perfectExpected: ExpectedProposal = {
	kind: "apply_intent_graph",
	entities: [
		{ type: "person", name: "Morris" },
		{ type: "project", name: "Lead Ads" },
		{ type: "todo", title: "Figure out the Rodeo side" },
	],
	links: [
		{ kind: "todo_project" },
		{ kind: "todo_person" },
		{ kind: "journal_ref" },
	],
};

describe("scoreProposal — apply_intent_graph alignment", () => {
	it("scores a perfect graph as entityF1 1.0 / fieldF1 1.0 / schemaValid", () => {
		const r = scoreProposal(perfectIntentGraph, perfectExpected);
		expect(r.schemaValid).toBe(true);
		expect(r.kindMatch).toBe(true);
		expect(r.entityF1).toBe(1);
		expect(r.fieldF1).toBe(1);
		expect(r.detail.entities.matched).toBe(3);
	});

	it("docks recall when an expected entity is missed (2 persons expected, 1 predicted)", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: {
				entities: [{ handle: "@a", type: "person", name: "Alice" }],
				links: [],
			},
		};
		const expected: ExpectedProposal = {
			kind: "apply_intent_graph",
			entities: [
				{ type: "person", name: "Alice" },
				{ type: "person", name: "Bob" },
			],
		};
		const r = scoreProposal(predicted, expected);
		expect(r.detail.entities.recall).toBeLessThan(1);
		expect(r.detail.entities.recall).toBeCloseTo(0.5, 5);
		expect(r.entityF1).toBeLessThan(1);
		// precision 1 (Alice matches), recall 0.5 (Bob missed) → F1 = 2·1·0.5/1.5.
		expect(r.detail.entities.precision).toBeCloseTo(1, 5);
		expect(r.entityF1).toBeCloseTo(2 / 3, 5);
	});

	it("docks precision when a hallucinated entity is predicted", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: {
				entities: [
					{ handle: "@a", type: "person", name: "Alice" },
					{ handle: "@x", type: "todo", title: "Extra unasked task" },
				],
				links: [],
			},
		};
		const expected: ExpectedProposal = {
			kind: "apply_intent_graph",
			entities: [{ type: "person", name: "Alice" }],
		};
		const r = scoreProposal(predicted, expected);
		expect(r.detail.entities.precision).toBeLessThan(1);
		expect(r.detail.entities.precision).toBeCloseTo(0.5, 5);
		expect(r.entityF1).toBeLessThan(1);
		// precision 0.5 (1 of 2 predicted matched), recall 1 → F1 = 2·0.5·1/1.5.
		expect(r.detail.entities.recall).toBeCloseTo(1, 5);
		expect(r.entityF1).toBeCloseTo(2 / 3, 5);
	});

	it("does NOT collapse two distinct projects sharing a prefix word (App vs Apple Pie Project)", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: {
				entities: [
					{ handle: "@p", type: "project", name: "Apple Pie Project" },
				],
				links: [],
			},
		};
		const expected: ExpectedProposal = {
			kind: "apply_intent_graph",
			entities: [{ type: "project", name: "App" }],
		};
		const r = scoreProposal(predicted, expected);
		// "apple pie project".includes("app") must NOT align them — they are two
		// different projects, so nothing matches: precision 0, recall 0, F1 0.
		expect(r.detail.entities.matched).toBe(0);
		expect(r.detail.entities.precision).toBe(0);
		expect(r.detail.entities.recall).toBe(0);
		expect(r.entityF1).toBe(0);
	});

	it("matches ONE expected against at most one of two same-tag duplicates (greedy dedup)", () => {
		// Two identical predicted persons against ONE expected person. align()'s
		// `used[]` + `break` guard must consume only ONE predicted, so the second
		// duplicate stays unmatched and docks precision. Dropping `break` (or the
		// `used` mark) would double-count the single expected → matched 2, precision
		// 1.0 — a false-HIGH that inflates precision. This pins matched 1.
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: {
				entities: [
					{ handle: "@a1", type: "person", name: "Alice" },
					{ handle: "@a2", type: "person", name: "Alice" },
				],
				links: [],
			},
		};
		const expected: ExpectedProposal = {
			kind: "apply_intent_graph",
			entities: [{ type: "person", name: "Alice" }],
		};
		const r = scoreProposal(predicted, expected);
		expect(r.detail.entities.matched).toBe(1);
		// 1 matched of 2 predicted → precision 0.5; 1 of 1 expected → recall 1.
		expect(r.detail.entities.precision).toBeCloseTo(0.5, 5);
		expect(r.detail.entities.recall).toBeCloseTo(1, 5);
		// entityF1 = f1(0.5, 1) = 2·0.5·1/1.5 = 2/3 (field-independent here).
		expect(r.entityF1).toBeCloseTo(2 / 3, 5);
	});

	it("docks fieldF1 but keeps entityF1 when a matched record has a wrong field", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: {
				entities: [
					{ handle: "@a", type: "person", name: "Alice", note: "wrong note" },
				],
				links: [],
			},
		};
		const expected: ExpectedProposal = {
			kind: "apply_intent_graph",
			entities: [{ type: "person", name: "Alice", note: "the right note" }],
		};
		const r = scoreProposal(predicted, expected);
		expect(r.entityF1).toBe(1); // record still aligns on type+name
		expect(r.fieldF1).toBeLessThan(1);
		// expected scored keys = name (correct) + note (wrong); type/handle excluded.
		// No EXTRA predicted scored keys (both name+note are expected) → precision 1,
		// recall 1/2 → fieldF1 = f1(1, 0.5) = 2·1·0.5/1.5 = 2/3.
		expect(r.detail.fields).toEqual({
			correct: 1,
			expectedTotal: 2,
			extraPredicted: 0,
		});
		expect(r.fieldF1).toBeCloseTo(2 / 3, 5);
	});

	it("scores fieldF1 = 1 when matched fields are exactly right (no extras)", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: {
				entities: [
					{ handle: "@a", type: "person", name: "Alice", note: "a note" },
				],
				links: [],
			},
		};
		const expected: ExpectedProposal = {
			kind: "apply_intent_graph",
			entities: [{ type: "person", name: "Alice", note: "a note" }],
		};
		const r = scoreProposal(predicted, expected);
		expect(r.detail.fields).toEqual({
			correct: 2,
			expectedTotal: 2,
			extraPredicted: 0,
		});
		expect(r.fieldF1).toBe(1);
	});

	it("docks fieldF1 (precision) when the prediction hallucinates an EXTRA field", () => {
		// Right expected fields PLUS a hallucinated `phone`. The protocol decode
		// ignores excess properties, so schemaValid + entityF1 stay perfect — only the
		// new field-precision term catches the bloat. Without it this scored 1.0.
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: {
				entities: [
					{
						handle: "@a",
						type: "person",
						name: "Alice",
						note: "a note",
						phone: "555-0100",
					},
				],
				links: [],
			},
		};
		const expected: ExpectedProposal = {
			kind: "apply_intent_graph",
			entities: [{ type: "person", name: "Alice", note: "a note" }],
		};
		const r = scoreProposal(predicted, expected);
		expect(r.entityF1).toBe(1); // record still aligns on type+name
		expect(r.fieldF1).toBeLessThan(1); // the precision hit
		// expected scored keys = name + note (both correct) → correct 2, expectedTotal
		// 2. predicted scored keys = name + note + phone → phone is EXTRA → 1.
		// precision = 2/(2+1) = 2/3, recall = 2/2 = 1 → fieldF1 = f1(2/3, 1) = 0.8.
		expect(r.detail.fields).toEqual({
			correct: 2,
			expectedTotal: 2,
			extraPredicted: 1,
		});
		expect(r.fieldF1).toBeCloseTo(0.8, 5);
	});
});

describe("scoreProposal — schema gate", () => {
	it("fails schemaValid + zeroes F1 when the payload is invalid (missing entities)", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: { links: [] }, // `entities` is required → decode fails
		};
		const r = scoreProposal(predicted, perfectExpected);
		expect(r.schemaValid).toBe(false);
		expect(r.entityF1).toBe(0);
		expect(r.obsF1).toBe(0);
		expect(r.fieldF1).toBe(0);
		expect(r.detail.reason).toBe("invalid");
	});

	it("fails the gate for an unregistered/hallucinated mutation_kind", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "create_widget", // not in @inkstone/protocol schemas
			payload: { name: "anything" },
		};
		const expected: ExpectedProposal = {
			kind: "create_person",
			fields: { name: "anything" },
		};
		const r = scoreProposal(predicted, expected);
		expect(r.schemaValid).toBe(false);
		expect(r.entityF1).toBe(0);
		expect(r.obsF1).toBe(0);
		expect(r.fieldF1).toBe(0);
		expect(r.detail.reason).toBe("unknown_kind");
	});

	it("preserves kindMatch:true on the CORRECT kind with an INVALID payload", () => {
		// FIX 11 pin: right mutation_kind (create_todo == expected.kind) but a body
		// that fails decode (`todo` is required). The invalid return must report
		// schemaValid:false AND kindMatch:true — "right kind, bad shape" is NOT a kind
		// mismatch, so it must not be conflated with one (which would undercount
		// kind_match_rate). reason "invalid" still disambiguates it from
		// "kind_mismatch".
		const predicted: PredictedProposal = {
			mutation_kind: "create_todo",
			payload: {}, // missing required `todo` → decode fails
		};
		const expected: ExpectedProposal = {
			kind: "create_todo",
			fields: { title: "Buy milk" },
		};
		const r = scoreProposal(predicted, expected);
		expect(r.schemaValid).toBe(false);
		expect(r.kindMatch).toBe(true);
		expect(r.detail.reason).toBe("invalid");
	});
});

describe("scoreProposal — none handling", () => {
	it("scores expected none + predicted null as perfect", () => {
		const r = scoreProposal(null, { kind: "none" });
		expect(r.schemaValid).toBe(true);
		expect(r.kindMatch).toBe(true);
		expect(r.entityF1).toBe(1);
		expect(r.obsF1).toBe(1);
		expect(r.fieldF1).toBe(1);
	});

	it("scores expected none + a proposed create_todo as a hallucination", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "create_todo",
			payload: { todo: { title: "unasked task" } },
		};
		const r = scoreProposal(predicted, { kind: "none" });
		expect(r.entityF1).toBe(0);
		expect(r.detail.reason).toBe("none_expected_but_proposed");
		expect(r.detail.entities.precision).toBe(0);
		// A VALID (but unwanted) proposal still decodes → schemaValid stays true; the
		// over-extraction is what zeroes the score, not a schema failure.
		expect(r.schemaValid).toBe(true);
	});

	it("reports schemaValid:false for expected none + an INVALID proposal", () => {
		// FIX 10 pin: when expected is none, a non-null prediction must still run the
		// real decode for schemaValid — a malformed (or bogus-kind) payload must NOT be
		// falsely reported schemaValid:true just because the answer was "propose
		// nothing". kindMatch stays false (expected none).
		const invalidPayload: PredictedProposal = {
			mutation_kind: "create_todo",
			payload: {}, // missing required `todo` → decode fails
		};
		const rInvalid = scoreProposal(invalidPayload, { kind: "none" });
		expect(rInvalid.schemaValid).toBe(false);
		expect(rInvalid.kindMatch).toBe(false);
		expect(rInvalid.detail.reason).toBe("none_expected_but_proposed");

		const bogusKind: PredictedProposal = {
			mutation_kind: "create_widget", // unregistered kind
			payload: { name: "anything" },
		};
		const rBogus = scoreProposal(bogusKind, { kind: "none" });
		expect(rBogus.schemaValid).toBe(false);
		expect(rBogus.kindMatch).toBe(false);
		expect(rBogus.detail.reason).toBe("none_expected_but_proposed");
	});

	it("scores expected non-none + predicted null as a miss", () => {
		const r = scoreProposal(null, {
			kind: "create_person",
			fields: { name: "Alice" },
		});
		expect(r.entityF1).toBe(0);
		expect(r.detail.reason).toBe("missed");
		expect(r.detail.entities.recall).toBe(0);
	});
});

describe("scoreProposal — record_observations", () => {
	it("scores obsF1 on the observation pool (bodyweight)", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "record_observations",
			payload: {
				observations: [
					{
						schema_key: "bodyweight",
						occurred_at: "2026-06-02T07:30:00",
						values: { kg: 72.4 },
					},
				],
			},
		};
		const expected: ExpectedProposal = {
			kind: "record_observations",
			observations: [{ schema_key: "bodyweight", values: { kg: 72.4 } }],
		};
		const r = scoreProposal(predicted, expected);
		expect(r.schemaValid).toBe(true);
		expect(r.obsF1).toBe(1);
		expect(r.detail.observations.matched).toBe(1);
	});

	it("docks obsF1 when an expected observation is missed", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "record_observations",
			payload: {
				observations: [
					{
						schema_key: "bodyweight",
						occurred_at: "2026-06-02T07:30:00",
						values: { kg: 72.4 },
					},
				],
			},
		};
		const expected: ExpectedProposal = {
			kind: "record_observations",
			observations: [
				{ schema_key: "bodyweight", values: { kg: 72.4 } },
				{ schema_key: "nutrition.intake", values: { kcal: 450 } },
			],
		};
		const r = scoreProposal(predicted, expected);
		expect(r.obsF1).toBeLessThan(1);
		expect(r.detail.observations.recall).toBeCloseTo(0.5, 5);
	});
});

describe("scoreProposal — single-entity create_*", () => {
	it("scores a perfect create_person", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "create_person",
			payload: { name: "Alice", note: "a friend" },
		};
		const expected: ExpectedProposal = {
			kind: "create_person",
			fields: { name: "Alice", note: "a friend" },
		};
		const r = scoreProposal(predicted, expected);
		expect(r.schemaValid).toBe(true);
		expect(r.kindMatch).toBe(true);
		expect(r.entityF1).toBe(1);
		expect(r.fieldF1).toBe(1);
	});
});

describe("scoreProposal — kind mismatch", () => {
	it("flags kindMatch false + reason kind_mismatch", () => {
		const predicted: PredictedProposal = {
			mutation_kind: "create_project",
			payload: { name: "Alice" },
		};
		const expected: ExpectedProposal = {
			kind: "create_person",
			fields: { name: "Alice" },
		};
		const r = scoreProposal(predicted, expected);
		expect(r.kindMatch).toBe(false);
		expect(r.detail.reason).toBe("kind_mismatch");
	});
});

describe("helpers", () => {
	it("normalize trims, lowercases, collapses whitespace", () => {
		expect(normalize("  Lead   Ads ")).toBe("lead ads");
	});

	it("projectBaseName strips a trailing activity qualifier against the expected name", () => {
		expect(projectBaseName("Lead Ads — Rodeo activity", "Lead Ads")).toBe(
			"lead ads",
		);
		expect(projectBaseName("Lead Ads", "Lead Ads")).toBe("lead ads");
	});

	it("projectBaseName does NOT collapse a non-prefix substring match (App vs Apple Pie Project)", () => {
		// "apple pie project" contains "app" but does not start with it → must stay
		// distinct (returns the predicted name as-is, not the expected base).
		expect(projectBaseName("Apple Pie Project", "App")).toBe(
			"apple pie project",
		);
	});

	it("f1 is the harmonic mean, 0 when either side is 0", () => {
		expect(f1(1, 1)).toBe(1);
		expect(f1(0.5, 1)).toBeCloseTo(0.6667, 3);
		expect(f1(0, 1)).toBe(0);
		expect(f1(1, 0)).toBe(0);
	});
});
