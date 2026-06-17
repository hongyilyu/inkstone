#!/usr/bin/env node
// PreToolUse gate for `git push` and `gh pr create`.
//
// Blocks a push or PR unless, in order:
//   1. the branch is rebased on origin/master (0 commits behind),
//   2. local CI passed for the CURRENT HEAD (a fresh marker from run-ci.mjs),
//   3. for `gh pr create`: the --title matches `verb(module): description`.
//
// Reads the tool call on stdin (PreToolUse payload), exits 2 with feedback on
// stderr to BLOCK, exits 0 to allow. Only inspects Bash commands; everything
// else passes straight through.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const BASE = "origin/master";
const VERBS = ["feat", "fix", "refactor", "docs", "test", "chore"];
// verb(module): description — module is required, lowercase verb, no trailing period.
const TITLE_RE = new RegExp(
	`^(${VERBS.join("|")})\\([a-z0-9 ,/_-]+\\): \\S.*[^.]$`,
);

function read(fd) {
	try {
		return readFileSync(fd, "utf8");
	} catch {
		return "";
	}
}

function block(msg) {
	process.stderr.write(`${msg}\n`);
	process.exit(2);
}

function allow() {
	process.exit(0);
}

function git(cmd) {
	return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

let payload;
try {
	payload = JSON.parse(read(0));
} catch {
	allow(); // can't parse — don't get in the way
}

if (payload?.tool_name !== "Bash") allow();
const command = String(payload?.tool_input?.command ?? "");

// Match the push / pr-create command at a statement boundary (start, or after
// a shell separator like && || | ; & or a subshell paren) so the trigger words
// can't false-positive from inside a -m message body or an unrelated argument.
const SEP = String.raw`(?:^|[;&|(])\s*`;
const isPush = new RegExp(`${SEP}git\\s+push\\b`).test(command);
const isPrCreate = new RegExp(`${SEP}gh\\s+pr\\s+create\\b`).test(command);
if (!isPush && !isPrCreate) allow();

const repoRoot = (() => {
	try {
		return git("rev-parse --show-toplevel");
	} catch {
		allow();
	}
})();
process.chdir(repoRoot);

// ── 1. Rebased on origin/master ─────────────────────────────────────────────
let behind = "0";
try {
	git("fetch origin master --quiet");
	behind = git(`rev-list --count HEAD..${BASE}`);
} catch (e) {
	block(
		`pre-push gate: could not verify rebase against ${BASE} (${String(e.message).split("\n")[0]}).\n` +
			`Run \`git fetch origin && git rebase ${BASE}\` then retry.`,
	);
}
if (behind !== "0") {
	block(
		`pre-push gate: BLOCKED — branch is ${behind} commit(s) behind ${BASE}.\n` +
			`Rebase first:  git fetch origin && git rebase ${BASE}\n` +
			`Then re-run local CI:  node .claude/hooks/run-ci.mjs`,
	);
}

// ── 2. Fresh local-CI pass marker for the current HEAD ───────────────────────
const head = git("rev-parse HEAD");
const gitDir = git("rev-parse --git-dir");
const marker = `${gitDir}/.ci-pass`;
if (!existsSync(marker)) {
	block(
		"pre-push gate: BLOCKED — no local-CI pass recorded.\n" +
			"Run the full gate:  node .claude/hooks/run-ci.mjs",
	);
}
const stamped = readFileSync(marker, "utf8").trim();
if (stamped !== head) {
	block(
		`pre-push gate: BLOCKED — local-CI marker is stale (passed for ${stamped.slice(0, 12)}, HEAD is ${head.slice(0, 12)}).\n` +
			"Re-run the full gate:  node .claude/hooks/run-ci.mjs",
	);
}

// ── 3. PR title format (gh pr create only) ───────────────────────────────────
if (isPrCreate) {
	const m =
		command.match(/--title[= ]+"((?:[^"\\]|\\.)*)"/) ||
		command.match(/--title[= ]+'([^']*)'/);
	if (!m) {
		block(
			"pre-push gate: BLOCKED — `gh pr create` must pass an explicit --title so it can be format-checked.\n" +
				"Format:  verb(module): description   e.g.  refactor(worker): split the Provider Helper",
		);
	}
	const title = m[1].replace(/\\"/g, '"');
	if (!TITLE_RE.test(title)) {
		block(
			`pre-push gate: BLOCKED — PR title does not match the commit format.\n` +
				`  got:      "${title}"\n` +
				`  expected: verb(module): description\n` +
				`  verb ∈ {${VERBS.join(", ")}}, module required, no trailing period.\n` +
				`  e.g.  fix(core): resume re-park correctness`,
		);
	}
}

allow();
