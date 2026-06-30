// The pure, testable core of the `pnpm eval` entry: load fixtures off disk,
// aggregate per-fixture ScoreResults into a single results row, append that row
// to a JSONL log, plus the keyless-skip guard. `index.ts` is the thin I/O shell
// that wires these to the real runner; everything graded by `eval.test.ts` lives
// here so it stays key-free.

import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture, ScoreResult } from "./types.js";
import { CODEX_ACCESS_TOKEN_ENV } from "./types.js";

/** A fixture plus the eval-only `holdout` marker. `holdout` is a harness concern
 * (split a held-out slice for measuring generalization), not part of the
 * runner-facing `Fixture` contract, so it lives here rather than on `Fixture`. */
export type EvalFixture = Fixture & { holdout?: boolean };

/** The fixture cohort a `pnpm eval` run measured — the only valid values of a
 * results row's `split`. Closed so an invalid cohort can't be serialized. */
export type Cohort = "all" | "holdout" | "no-holdout";

/** The directory holding the eval fixtures (`eval/cases/*.json`), resolved from
 * this module's location so the load works regardless of cwd. */
const CASES_DIR = join(dirname(fileURLToPath(import.meta.url)), "cases");

/** Load every `cases/*.json` fixture into an `EvalFixture[]`. JSON files are data,
 * not code — we read + `JSON.parse` each; the `eval.test.ts` (a) block asserts
 * they conform to the `Fixture` shape, so a malformed fixture reds CI rather than
 * silently mis-scoring. */
export function loadFixtures(dir: string = CASES_DIR): EvalFixture[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalFixture);
}

/** The aggregate metrics across a run: mean entity/obs/field F1, the
 * `kind_match_rate` (fraction of fixtures whose proposed mutation_kind matched the
 * expected kind), + the fixture count. Means over an empty set are 0 (n=0), never
 * NaN. `kind_match_rate` is tracked separately from `entity_f1` because a proposal
 * can wrap the CORRECT records under the WRONG kind (e.g. an apply_intent_graph
 * that should have been a create_todo): entity_f1 still credits the record-level
 * match, so without a kind metric a kind-confusion regression would be invisible. */
export interface Aggregate {
	entity_f1: number;
	obs_f1: number;
	field_f1: number;
	kind_match_rate: number;
	n: number;
}

const mean = (xs: number[]): number =>
	xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Mean each F1 + the kind-match rate across the per-fixture results. */
export function aggregate(results: ScoreResult[]): Aggregate {
	return {
		entity_f1: mean(results.map((r) => r.entityF1)),
		obs_f1: mean(results.map((r) => r.obsF1)),
		field_f1: mean(results.map((r) => r.fieldF1)),
		kind_match_rate: mean(results.map((r) => (r.kindMatch ? 1 : 0))),
		n: results.length,
	};
}

/** One appended row in `results.jsonl`: the aggregate metrics + a wall-clock
 * timestamp + a short hash of the system prompt the run drove (so a row is
 * attributable to a specific prompt revision) + the fixture cohort the run
 * covered (`split`: "holdout" / "no-holdout" / "all"), so a row is unambiguously
 * attributable to the cohort it measured. */
export interface ResultsRow extends Aggregate {
	date: string;
	prompt_hash: string;
	split: Cohort;
}

/** A short, stable hash of the system prompt — sha256 hex, first 12 chars — used
 * to tag a results row with the prompt revision it measured. */
export function promptHash(prompt: string): string {
	return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

/** Build the results row from an aggregate + the prompt hash + the cohort split.
 * `date` is real wall-clock time (tooling code — a fixed clock buys nothing here). */
export function resultsRow(
	agg: Aggregate,
	promptHashHex: string,
	split: Cohort,
): ResultsRow {
	return {
		date: new Date().toISOString(),
		prompt_hash: promptHashHex,
		split,
		entity_f1: agg.entity_f1,
		obs_f1: agg.obs_f1,
		field_f1: agg.field_f1,
		kind_match_rate: agg.kind_match_rate,
		n: agg.n,
	};
}

/** Append ONE JSON row (newline-terminated) to the JSONL log at `path`. */
export function appendResultRow(path: string, row: ResultsRow): void {
	appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** Whether a real provider credential is present. The keyless guard: with the
 * token env var unset, the eval prints a skip notice and exits 0 — it never
 * fails for want of a key (so CI stays green). */
export function hasApiKey(): boolean {
	const token = process.env[CODEX_ACCESS_TOKEN_ENV];
	return token !== undefined && token.trim().length > 0;
}
