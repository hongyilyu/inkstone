#!/usr/bin/env node
// Local CI runner — the gate from CLAUDE.md §6, run in order. On full success
// it stamps `.git/.ci-pass` with the current HEAD sha; the pre-push gate
// requires that marker to match HEAD before a push / PR is allowed.
//
// Usage:  node .claude/hooks/run-ci.mjs
// Re-run after any new commit, amend, or rebase (the marker is HEAD-pinned).

import { execSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Mirror the CI jobs in .github/workflows/ci.yml EXACTLY.
// lint-format runs `biome ci .` (format + lint + organizeImports) — NOT
// `biome lint`/`biome format`, which miss import-ordering and let CI fail.
const STEPS = [
	["pnpm exec biome ci .", "lint-format (biome ci)"],
	["pnpm check", "ts + rust (tsc -b + cargo check)"],
	["pnpm -r test", "package tests (vitest)"],
	[
		"cargo test --manifest-path crates/core/Cargo.toml",
		"core tests (cargo)",
	],
	["pnpm test:e2e", "e2e harness (playwright)"],
];

function git(cmd) {
	return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

const repoRoot = git("rev-parse --show-toplevel");
process.chdir(repoRoot);
const head = git("rev-parse HEAD");
const gitDir = git("rev-parse --git-dir");

console.log(`Local CI for ${head.slice(0, 12)} — ${STEPS.length} steps\n`);

for (const [cmd, label] of STEPS) {
	process.stdout.write(`▶ ${label}: ${cmd}\n`);
	const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
	if (r.status !== 0) {
		console.error(
			`\n✗ FAILED at: ${label} (exit ${r.status ?? "signal"})\n` +
				"Local CI did not pass — no marker written; push/PR stays blocked.",
		);
		process.exit(1);
	}
	console.log(`✓ ${label}\n`);
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
