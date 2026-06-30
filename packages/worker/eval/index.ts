// `pnpm eval` entry. Loads every fixture, and — only when explicitly opted in via
// INKSTONE_EVAL_LIVE=1 AND a real provider credential (INKSTONE_CODEX_ACCESS_TOKEN)
// — drives each through the real interpreter (`runFixture`), scores the captured
// proposal (`scoreProposal`), prints a per-fixture line + an aggregate summary, and
// appends one row to `results.jsonl`. Without BOTH it prints a skip notice and
// exits 0: the eval is a tool, never a CI gate, so it must never fail (or
// surprise-spend tokens) for want of an explicit opt-in.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	aggregate,
	appendResultRow,
	type EvalFixture,
	hasApiKey,
	loadFixtures,
	promptHash,
	resultsRow,
} from "./aggregate.js";
import { loadSystemPrompt, runFixture } from "./run.js";
import { scoreProposal } from "./score.js";
import type { ScoreResult } from "./types.js";

const RESULTS_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"results.jsonl",
);

const f3 = (n: number): string => n.toFixed(3);
const snippet = (s: string, max = 48): string =>
	s.length <= max ? s : `${s.slice(0, max - 1)}…`;

/** Optional arg: `--holdout` runs only holdout fixtures, `--no-holdout` only the
 * rest; absent → all. */
function selectFixtures(
	all: EvalFixture[],
	arg: string | undefined,
): EvalFixture[] {
	if (arg === "--holdout") return all.filter((f) => f.holdout === true);
	if (arg === "--no-holdout") return all.filter((f) => f.holdout !== true);
	return all;
}

/** The eval is opt-in: it only drives the real model when INKSTONE_EVAL_LIVE=1
 * AND a provider credential is present. The token alone (it's the SAME token real
 * chat uses) must not turn a bare run into a token-spending live run — the explicit
 * flag is the consent gate. Mirrors `run.test.ts`'s LIVE gate so the harness is
 * opt-in everywhere. */
const LIVE = process.env.INKSTONE_EVAL_LIVE === "1" && hasApiKey();

async function main(): Promise<void> {
	const arg = process.argv[2];

	// Reject an unknown flag (e.g. a typo `--holodut`) BEFORE any model call so a
	// fat-fingered cohort flag fails fast instead of silently running the FULL suite.
	if (arg !== undefined && arg !== "--holdout" && arg !== "--no-holdout") {
		console.error(
			`eval: unknown argument "${arg}" — expected --holdout, --no-holdout, or none`,
		);
		process.exit(1);
	}

	if (!LIVE) {
		console.log(
			"eval skipped — set INKSTONE_EVAL_LIVE=1 and INKSTONE_CODEX_ACCESS_TOKEN to run against the real model",
		);
		process.exit(0);
	}

	const split =
		arg === "--holdout"
			? "holdout"
			: arg === "--no-holdout"
				? "no-holdout"
				: "all";

	const fixtures = selectFixtures(loadFixtures(), arg);
	console.log(`Running ${fixtures.length} fixtures against the real model…\n`);

	const results: ScoreResult[] = [];
	for (const fixture of fixtures) {
		const predicted = await runFixture(fixture);
		const result = scoreProposal(predicted, fixture.expected);
		results.push(result);
		const kind = result.kindMatch ? "ok " : "MISS";
		console.log(
			`[${kind}] ${snippet(fixture.message).padEnd(48)}  ` +
				`ent=${f3(result.entityF1)} obs=${f3(result.obsF1)} fld=${f3(result.fieldF1)}` +
				`${result.detail.reason ? `  (${result.detail.reason})` : ""}`,
		);
	}

	const agg = aggregate(results);
	console.log(
		`\nn=${agg.n}  entity_f1=${f3(agg.entity_f1)}  obs_f1=${f3(agg.obs_f1)}  field_f1=${f3(agg.field_f1)}  kind_match_rate=${f3(agg.kind_match_rate)}`,
	);

	const row = resultsRow(agg, promptHash(loadSystemPrompt()), split);
	appendResultRow(RESULTS_PATH, row);
	console.log(`Appended results row to ${RESULTS_PATH}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
