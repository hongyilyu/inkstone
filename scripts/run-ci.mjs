#!/usr/bin/env node
// Local CI runner — mirrors the CI jobs in .github/workflows/ci.yml, run
// CONCURRENTLY (like CI, whose jobs run in parallel) so wall-clock ≈ the slowest
// lane, not the sum. On full success it stamps `.git/.ci-pass` with the current
// HEAD sha; the pre-push gate requires that marker to match HEAD before a push.
//
// Usage:  node scripts/run-ci.mjs
// Re-run after any new commit, amend, or rebase (the marker is HEAD-pinned).

import { execSync, spawn } from "node:child_process";
import { createWriteStream, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One lane per CI job. `biome ci .` (format + lint + organizeImports) is the
// lint-format job — NOT `biome lint`/`biome format`, which miss import-ordering.
// e2e runs 8 workers (the suite is parallel-safe per ADR-0019; --workers
// overrides the config's default of 4).
const LANES = [
	{ name: "lint-format", cmd: "pnpm exec biome ci ." },
	{ name: "ts+rust", cmd: "pnpm check" },
	{ name: "pkg-tests", cmd: "pnpm -r test" },
	{
		name: "core-tests",
		cmd: "cargo test --manifest-path crates/core/Cargo.toml",
	},
	{ name: "e2e", cmd: "pnpm -C tests/e2e exec playwright test --workers=8" },
];

function git(cmd) {
	return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

const repoRoot = git("rev-parse --show-toplevel");
process.chdir(repoRoot);
const head = git("rev-parse HEAD");
const gitDir = git("rev-parse --git-dir");
const logDir = mkdtempSync(join(tmpdir(), "run-ci-"));

console.log(
	`Local CI for ${head.slice(0, 12)} — ${LANES.length} lanes in parallel`,
);
console.log(`(logs: ${logDir})\n`);

function runLane(lane) {
	return new Promise((resolve) => {
		const logPath = join(logDir, `${lane.name}.log`);
		const out = createWriteStream(logPath);
		const t0 = process.hrtime.bigint();
		const child = spawn(lane.cmd, {
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.pipe(out);
		child.stderr.pipe(out);
		process.stdout.write(`▶ ${lane.name}\n`);
		child.on("close", (code) => {
			const secs = Number((process.hrtime.bigint() - t0) / 1_000_000n) / 1000;
			const okk = code === 0;
			process.stdout.write(
				`${okk ? "✓" : "✗"} ${lane.name} (${secs.toFixed(1)}s)${okk ? "" : ` — exit ${code}, see ${logPath}`}\n`,
			);
			resolve({ ...lane, code, logPath, secs });
		});
	});
}

const results = await Promise.all(LANES.map(runLane));
const failed = results.filter((r) => r.code !== 0);

if (failed.length > 0) {
	console.error(
		`\n✗ ${failed.length} lane(s) FAILED: ${failed.map((f) => f.name).join(", ")}`,
	);
	for (const f of failed) {
		console.error(`\n──── ${f.name} (last 40 lines of ${f.logPath}) ────`);
		try {
			console.error(execSync(`tail -40 ${f.logPath}`, { encoding: "utf8" }));
		} catch {}
	}
	console.error(
		"Local CI did not pass — no marker written; push/PR stays blocked.",
	);
	process.exit(1);
}

// Pin the marker to the sha we actually tested. If HEAD moved during the run
// (a commit mid-CI), refuse to stamp — the result no longer describes HEAD.
const headNow = git("rev-parse HEAD");
if (headNow !== head) {
	console.error(
		`\n✗ HEAD moved during CI (${head.slice(0, 12)} → ${headNow.slice(0, 12)}). Re-run after settling.`,
	);
	process.exit(1);
}
writeFileSync(`${gitDir}/.ci-pass`, `${head}\n`);
console.log(`\n✓ Local CI PASSED — marker stamped for ${head.slice(0, 12)}.`);
console.log("Push / PR is now unblocked for this exact HEAD.");
