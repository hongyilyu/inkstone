// Key-free tests for the eval ENTRY (`index.ts`) + its pure helpers
// (`aggregate.ts`) + the read-not-copy prompt (`run.ts`). All four blocks run in
// a normal keyless CI: they touch only on-disk fixtures, the pure aggregate fn,
// a temp-file append, and the TOML prompt read — never the real model.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	aggregate,
	appendResultRow,
	hasApiKey,
	loadFixtures,
	resultsRow,
} from "./aggregate.js";
import { loadSystemPrompt } from "./run.js";
import { scoreProposal } from "./score.js";
import type { PredictedProposal, ScoreResult } from "./types.js";

const ALLOWED_KINDS = new Set([
	"apply_intent_graph",
	"record_observations",
	"create_todo",
	"create_person",
	"create_project",
	"create_journal_entry",
	"none",
]);

// (a) Fixtures load + parse against the Fixture shape.
describe("eval fixtures", () => {
	const fixtures = loadFixtures();

	it("loads at least 20 fixtures", () => {
		expect(fixtures.length).toBeGreaterThanOrEqual(20);
	});

	it("each fixture parses against the Fixture shape", () => {
		for (const f of fixtures) {
			expect(typeof f.message).toBe("string");
			expect(f.message.length).toBeGreaterThan(0);
			expect(Array.isArray(f.world)).toBe(true);
			expect(f.expected).toBeDefined();
			expect(ALLOWED_KINDS.has(f.expected.kind)).toBe(true);
			for (const e of f.world) {
				expect(typeof e.id).toBe("string");
				expect(typeof e.name).toBe("string");
				expect(typeof e.type).toBe("string");
			}
		}
	});

	it("covers every required category", () => {
		const kinds = new Set<string>(fixtures.map((f) => f.expected.kind));
		for (const k of [
			"apply_intent_graph",
			"record_observations",
			"create_todo",
			"create_person",
			"create_project",
			"create_journal_entry",
			"none",
		]) {
			expect(kinds.has(k)).toBe(true);
		}
	});

	it("marks roughly 5 fixtures as holdout", () => {
		const holdout = fixtures.filter((f) => f.holdout === true);
		expect(holdout.length).toBeGreaterThanOrEqual(4);
		expect(holdout.length).toBeLessThanOrEqual(8);
	});
});

// (b) Aggregate the per-fixture ScoreResults into the 6-field row, then append
// it to a TEMP file and read it back as JSON.
describe("aggregate + append", () => {
	function score(
		entityF1: number,
		obsF1: number,
		fieldF1: number,
		kindMatch = true,
	): ScoreResult {
		return {
			schemaValid: true,
			kindMatch,
			entityF1,
			obsF1,
			fieldF1,
			detail: {
				entities: {
					precision: 0,
					recall: 0,
					matched: 0,
					predicted: 0,
					expected: 0,
				},
				observations: {
					precision: 0,
					recall: 0,
					matched: 0,
					predicted: 0,
					expected: 0,
				},
				fields: { correct: 0, expectedTotal: 0, extraPredicted: 0 },
			},
		};
	}

	it("aggregate computes the mean F1s, kind_match_rate, and count, mapping each field to its own key", () => {
		// DISTINCT per-field means so an entity↔obs↔field key swap reds: entity → 0.6,
		// obs → 0.3, field → 0.7. kind_match_rate is a FOURTH distinct value (0.5: one
		// kindMatch true, one false) so a kind→F1 mis-map reds too.
		const agg = aggregate([
			score(1, 0.5, 0.8, true),
			score(0.2, 0.1, 0.6, false),
		]);
		expect(agg.entity_f1).toBeCloseTo(0.6, 5);
		expect(agg.obs_f1).toBeCloseTo(0.3, 5);
		expect(agg.field_f1).toBeCloseTo(0.7, 5);
		expect(agg.kind_match_rate).toBeCloseTo(0.5, 5);
		expect(agg.n).toBe(2);
	});

	it("aggregate over an empty set is all-zero, n=0", () => {
		const agg = aggregate([]);
		expect(agg).toEqual({
			entity_f1: 0,
			obs_f1: 0,
			field_f1: 0,
			kind_match_rate: 0,
			n: 0,
		});
	});

	it("resultsRow has the 8-field shape + types", () => {
		const row = resultsRow(aggregate([score(1, 1, 1)]), "abc123def456", "all");
		expect(typeof row.date).toBe("string");
		expect(typeof row.prompt_hash).toBe("string");
		expect(row.split).toBe("all");
		expect(typeof row.entity_f1).toBe("number");
		expect(typeof row.obs_f1).toBe("number");
		expect(typeof row.field_f1).toBe("number");
		expect(typeof row.kind_match_rate).toBe("number");
		expect(typeof row.n).toBe("number");
		expect(Object.keys(row).sort()).toEqual(
			[
				"date",
				"entity_f1",
				"field_f1",
				"kind_match_rate",
				"n",
				"obs_f1",
				"prompt_hash",
				"split",
			].sort(),
		);
	});

	it("appendResultRow writes ONE JSON line that parses back with all 8 fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "eval-results-"));
		const file = join(dir, "results.jsonl");
		// Two fixtures, ONE kind mismatch → kind_match_rate 0.5 (distinct from the F1s).
		const row = resultsRow(
			aggregate([score(0.8, 0.6, 0.9, true), score(0.8, 0.6, 0.9, false)]),
			"deadbeef0000",
			"holdout",
		);
		appendResultRow(file, row);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed).toMatchObject({
			prompt_hash: "deadbeef0000",
			n: 2,
			split: "holdout",
		});
		for (const k of [
			"date",
			"prompt_hash",
			"split",
			"entity_f1",
			"obs_f1",
			"field_f1",
			"kind_match_rate",
			"n",
		]) {
			expect(parsed[k]).toBeDefined();
		}
		// Assert the VALUES land on the right keys (distinct 0.8/0.6/0.9/0.5), so a swap
		// in the aggregate→row→append path reds instead of sailing through on shape.
		expect(parsed.entity_f1).toBeCloseTo(0.8, 5);
		expect(parsed.obs_f1).toBeCloseTo(0.6, 5);
		expect(parsed.field_f1).toBeCloseTo(0.9, 5);
		expect(parsed.kind_match_rate).toBeCloseTo(0.5, 5);
	});
});

// (b2) The six single-entity create_* fixtures must carry a name/title in
// `expected.fields`, or the scorer aligns the expected entity (name `undefined`)
// against NO correctly-named prediction — entityF1 collapses to 0 on a PERFECT
// model output, dragging the aggregate headline down by a constant unrelated to
// model quality. This block proves alignment: for each fixture we synthesize the
// proposal a good model would emit (the canonical title/name) and assert
// entityF1 === 1. RED against fixtures missing `expected.fields`.
describe("create_* fixtures align with a correct prediction (no false zero)", () => {
	// The canonical title/name a good model would emit for each fixture's message.
	// MUST equal `expected.fields.{title,name}` in the fixture for the scorer to
	// align the single expected entity against the prediction.
	const cases: Array<{
		file: string;
		// The fixture's unique `message`, used to find it among loadFixtures().
		message: string;
		mutation_kind: "create_todo" | "create_project";
		// The predicted payload a good model emits; `todo` nests, project is flat.
		payload: Record<string, unknown>;
	}> = [
		{
			file: "project-lisbon-trip.json",
			message: "Create a project to plan the Lisbon trip.",
			mutation_kind: "create_project",
			payload: { name: "Plan the Lisbon trip" },
		},
		{
			file: "todo-call-dentist.json",
			message: "I need to call the dentist to reschedule my cleaning.",
			mutation_kind: "create_todo",
			payload: { todo: { title: "Call the dentist to reschedule cleaning" } },
		},
		{
			file: "todo-email-alice.json",
			message: "I need to email Alice about the quarterly numbers.",
			mutation_kind: "create_todo",
			payload: { todo: { title: "Email Alice about the quarterly numbers" } },
		},
		{
			file: "todo-followup-carol.json",
			message: "Follow up with Carol on the vendor contract.",
			mutation_kind: "create_todo",
			payload: {
				todo: { title: "Follow up with Carol on the vendor contract" },
			},
		},
		{
			file: "todo-renew-passport.json",
			message: "Todo: renew my passport before it expires.",
			mutation_kind: "create_todo",
			payload: { todo: { title: "Renew my passport" } },
		},
		{
			file: "todo-wait-alice-schedule.json",
			message: "Wait for Alice to send the daycare schedule.",
			mutation_kind: "create_todo",
			payload: {
				todo: { title: "Wait for Alice to send the daycare schedule" },
			},
		},
	];

	const fixtures = loadFixtures();

	for (const c of cases) {
		it(`${c.file} → entityF1 === 1 on a perfect prediction`, () => {
			const fixture = fixtures.find((f) => f.message === c.message);
			expect(fixture, `fixture ${c.file} not found`).toBeDefined();
			if (!fixture) return;
			const predicted: PredictedProposal = {
				mutation_kind: c.mutation_kind,
				payload: c.payload,
			};
			const r = scoreProposal(predicted, fixture.expected);
			expect(r.schemaValid).toBe(true);
			expect(r.kindMatch).toBe(true);
			expect(r.entityF1).toBe(1);
			expect(r.detail.entities.matched).toBe(1);
		});
	}
});

// (b3) FIELD-EXHAUSTIVE invariant (see `ExpectedProposal` in types.ts): a correct
// model must score fieldF1 === 1 on the backfilled fixtures. Each case synthesizes
// the exact payload a good model would emit and asserts no field-precision penalty
// fires — RED if a backfilled `expected` under-specifies (a hallucination-free
// model would dock on an extra) or over-specifies (the model would miss a recall
// key). Pins all three backfill shapes: a trimmed graph (no spurious `due_at`), a
// `note` on a create_person, and observation `values` with `occurred_at` excluded.
describe("backfilled fixtures: a correct model scores fieldF1 === 1", () => {
	const fixtures = loadFixtures();
	const find = (message: string) => {
		const f = fixtures.find((x) => x.message === message);
		expect(f, `fixture for "${message}" not found`).toBeDefined();
		return f;
	};

	it("graph-project-with-action: trimmed message → no due_at to penalize", () => {
		const fixture = find(
			"Spent time on the Lead Ads project. I need to figure out the Rodeo side of it.",
		);
		if (!fixture) return;
		const predicted: PredictedProposal = {
			mutation_kind: "apply_intent_graph",
			payload: {
				journal_entry: {
					handle: "@je",
					occurred_at: "2026-06-30T10:00:00",
					body: [
						{ type: "text", text: "Spent time on " },
						{ type: "entity_ref", target: "@leadads" },
					],
				},
				entities: [
					{
						handle: "@leadads",
						type: "project",
						name: "Lead Ads",
						existing_id: "0190d3c1-0000-7000-8000-0000000000e1",
					},
					{
						handle: "@rodeo",
						type: "todo",
						title: "Figure out the Rodeo side",
					},
				],
				links: [
					{ kind: "journal_ref", from: "@je", to: "@leadads" },
					{ kind: "todo_project", from: "@rodeo", to: "@leadads" },
				],
			},
		};
		const r = scoreProposal(predicted, fixture.expected);
		expect(r.schemaValid).toBe(true);
		expect(r.fieldF1).toBe(1);
		expect(r.detail.fields.extraPredicted).toBe(0);
	});

	it("person-alice-daycare: note backfilled → emitting it is not an extra", () => {
		const fixture = find("Remember Alice is the daycare coordinator.");
		if (!fixture) return;
		const predicted: PredictedProposal = {
			mutation_kind: "create_person",
			payload: { name: "Alice", note: "daycare coordinator" },
		};
		const r = scoreProposal(predicted, fixture.expected);
		expect(r.schemaValid).toBe(true);
		expect(r.fieldF1).toBe(1);
		expect(r.detail.fields.extraPredicted).toBe(0);
	});

	it("obs-bodyweight: required occurred_at is excluded → no precision hit", () => {
		const fixture = find("Weighed 75.2kg this morning.");
		if (!fixture) return;
		const predicted: PredictedProposal = {
			mutation_kind: "record_observations",
			payload: {
				observations: [
					{
						schema_key: "bodyweight",
						occurred_at: "2026-06-30T08:00:00",
						values: { kg: 75.2 },
					},
				],
			},
		};
		const r = scoreProposal(predicted, fixture.expected);
		expect(r.schemaValid).toBe(true);
		expect(r.obsF1).toBe(1);
		expect(r.fieldF1).toBe(1);
		expect(r.detail.fields.extraPredicted).toBe(0);
	});
});

// (c) The read-not-copy prompt loads from the TOML.
describe("loadSystemPrompt (read-not-copy)", () => {
	it("returns the real non-empty prompt from default.toml", () => {
		const prompt = loadSystemPrompt();
		expect(prompt.length).toBeGreaterThan(0);
		expect(prompt.startsWith("You are Inkstone's assistant")).toBe(true);
	});

	it("extracts the prompt body up to (not including) the closing delimiter", () => {
		const prompt = loadSystemPrompt();
		// The real final line of default.toml's system_prompt block (the two-space
		// indented continuation of the GTD link step). Pins the CLOSE boundary so a
		// regression that swallows the closing `"""` or the trailing `tools = [` line
		// reds — without this, only the START was checked.
		expect(
			prompt.endsWith(
				"  unlinked. Recover the new Todo's id with search_entities before linking.",
			),
		).toBe(true);
		// The extraction must stop at the delimiter: neither the closing triple-quote
		// nor the following `tools = [` line may leak into the prompt.
		expect(prompt).not.toContain('"""');
		expect(prompt).not.toContain("tools = [");
	});
});

// (d) The keyless-skip guard: with the env var unset, the harness must skip.
describe("hasApiKey (keyless skip guard)", () => {
	it("returns false when the token env var is unset", () => {
		const saved = process.env.INKSTONE_CODEX_ACCESS_TOKEN;
		delete process.env.INKSTONE_CODEX_ACCESS_TOKEN;
		try {
			expect(hasApiKey()).toBe(false);
		} finally {
			if (saved !== undefined) process.env.INKSTONE_CODEX_ACCESS_TOKEN = saved;
		}
	});

	it("returns true when the token env var is set", () => {
		const saved = process.env.INKSTONE_CODEX_ACCESS_TOKEN;
		process.env.INKSTONE_CODEX_ACCESS_TOKEN = "fake-token";
		try {
			expect(hasApiKey()).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.INKSTONE_CODEX_ACCESS_TOKEN;
			else process.env.INKSTONE_CODEX_ACCESS_TOKEN = saved;
		}
	});
});
