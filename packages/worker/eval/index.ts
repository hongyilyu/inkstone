// `pnpm eval` entry. Loads every fixture, and — only with a real provider
// credential — drives each through the real interpreter (`runFixture`), scores
// the captured proposal (`scoreProposal`), prints a per-fixture line + an
// aggregate summary, and appends one row to `results.jsonl`. With NO credential
// it prints a skip notice and exits 0: the eval is a tool, never a CI gate, so it
// must never fail for want of a key.

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

async function main(): Promise<void> {
	if (!hasApiKey()) {
		console.log(
			"eval skipped — set INKSTONE_CODEX_ACCESS_TOKEN to run against the real model",
		);
		process.exit(0);
	}

	const fixtures = selectFixtures(loadFixtures(), process.argv[2]);
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
		`\nn=${agg.n}  entity_f1=${f3(agg.entity_f1)}  obs_f1=${f3(agg.obs_f1)}  field_f1=${f3(agg.field_f1)}`,
	);

	const row = resultsRow(agg, promptHash(loadSystemPrompt()));
	appendResultRow(RESULTS_PATH, row);
	console.log(`Appended results row to ${RESULTS_PATH}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
