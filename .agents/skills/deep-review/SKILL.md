---
name: deep-review
description: >-
  Self-improving local code reviewer (a CodeRabbit-class review that runs
  locally, no SaaS). Use when the user wants to review a diff/PR/branch before
  submitting, run a deep multi-agent code review, "deep review", catch bugs a
  single pass misses, OR to teach the reviewer from past PR review comments
  ("learn from the PRs", mine CodeRabbit/Copilot/Codex/human review comments
  into rules), OR to check learning status/watermarks. Three modes: run, learn,
  status.
---

# deep-review — self-improving local code reviewer

A multi-agent code reviewer that runs **entirely locally** (no internal tools, no SaaS) and **gets
better over time** by learning from review comments real reviewers (CodeRabbit, Copilot, Codex,
humans) leave on PRs. It beats a single `/code-review` pass via three things: **specialist fan-out**
(parallel reviewers per lens), **adversarial verification** (a second pass refutes weak findings to
kill false positives), and a **persistent learned rule base**.

## Self-contained — everything lives in this skill

This skill bundles its own brain; it depends on nothing outside this directory (`SKILL_DIR` below =
the folder containing this file, e.g. `<repo>/.agents/skills/deep-review/`). Commit it and it travels
with the repo — a teammate who checks out the repo gets the full reviewer and its accumulated rules.

- **Rule base:** `SKILL_DIR/learnings/` — `rules.json` (source of truth, **268 rules**), `INDEX.md`,
  `by-category/*.md`, `CHANGELOG.md`.
- **Watermarks:** `SKILL_DIR/learnings/state.json` — per-repo cursor of the newest review comment
  already mined (so `learn` continues where it left off).
- **Specialists:** `SKILL_DIR/agents/` — 13 reviewer role prompts: `dr-correctness`, `dr-concurrency`,
  `dr-security`, `dr-error-handling`, `dr-resource-leak`, `dr-api-compat`, `dr-performance`,
  `dr-data-persistence`, `dr-types`, `dr-ui-react`, `dr-testing`, `dr-code-quality`, and the
  adversarial `dr-verifier`.
- **KB rebuilder:** `python3 SKILL_DIR/build_kb.py` regenerates `INDEX.md` + `by-category/*.md` from
  `rules.json` (never hand-edit those).

**How specialists run:** these are role prompts, not registered subagent types. To run a specialist,
**Read its file** (`SKILL_DIR/agents/<name>.md`, skip the YAML frontmatter) and dispatch a generic
**Task** agent whose prompt is that file's body + the concrete inputs (the diff, changed files, and a
pointer to `SKILL_DIR/learnings/by-category/<category>.md`). Fan out multiple Task calls in one
message to run them concurrently. The agent files refer to their rules via a `<deep-review skill>`
placeholder — **substitute it with this skill's real absolute path** (resolve `SKILL_DIR` once at the
start of the run, e.g. `<repo>/.agents/skills/deep-review`) before handing the prompt to the Task agent.

This repo (`hongyilyu/inkstone`) is already a tracked source. Use `git remote get-url origin` to
identify the current repo when a mode needs it.

## Modes

Pick the mode from the user's request (default to **run** if they just say "deep review"):

| Mode | When | What it does |
|---|---|---|
| **run** | "review my changes / this PR / branch before I submit" | Multi-agent review of a diff → verified findings |
| **learn** | "learn from the PRs", "mine review comments", after others review your CR | Mine others' review comments into new rules |
| **status** | "what's the learning status / backlog / when did we last check" | Show per-repo watermarks + pending backlog (read-only) |

---

## § RUN — review the diff

Use **before** submitting a PR/CR. Fans out specialists, adversarially verifies every finding, applies the learned rules.

### R1 — Resolve the diff
- nothing specified → `git diff HEAD` + `git diff --staged`; if both empty, review the last commit (`git show HEAD`).
- a git range/ref (`main..HEAD`, `HEAD~3`) → `git diff <range>`.
- a PR number → `gh pr diff <n>`.
- specific paths → diff limited to those paths.

Capture changed files, the unified diff, and language mix. Empty diff → say so and stop. Huge diff (>~1500 lines) → review highest-risk files first and note it.

### R2 — Load learned rules
Read `SKILL_DIR/learnings/INDEX.md` and `rules.json`. These bias specialists toward issues actually flagged before (incl. inkstone's own history). Absent → review from first principles.

### R3 — Select specialists by what changed
Always: **dr-correctness**, **dr-error-handling**. Conditionally add:
- async/Promise/await/concurrent state → **dr-concurrency**
- shell/exec, terminal escape sequences, HTML/render, paths, untrusted input, auth, file I/O → **dr-security**
- listeners/observers/timers/streams/handles/subscriptions → **dr-resource-leak**
- exported API, config keys, CLI flags, serialized/wire formats → **dr-api-compat**
- hot paths, loops with I/O, caches, render paths → **dr-performance**
- DB migrations, transactions, persisted state → **dr-data-persistence**
- TS type/interface/schema changes → **dr-types**
- React/Solid components, hooks, effects, JSX, TUI render code → **dr-ui-react**
- bug fix / new logic with no or weak tests → **dr-testing**
- copy-pasted / cross-module duplicated logic → **dr-code-quality**

State which specialists you're running and why.

### R4 — Fan out (parallel)
For each selected specialist, Read `SKILL_DIR/agents/<name>.md` and launch a **Task** agent (all in one message, concurrently) with that role prompt + the diff, the changed-file list, and a pointer to its `SKILL_DIR/learnings/by-category/<category>.md`. Each returns findings JSON (confidence ≥ 75 only).

### R5 — Adversarially verify every finding
Collect findings; dedup by (file, line, category). For each, launch a **dr-verifier** Task (read `SKILL_DIR/agents/dr-verifier.md`, parallelize) that tries to *refute* it. **Drop any finding the verifier returns `keep=false`**; apply its `corrected_severity`/`corrected_fix` when kept. Mandatory — this keeps signal high.

### R6 — Report
Group verified findings by severity (Blocking → Important → Nit). For each: `file:line` · category · explanation · concrete fix · `(matched rule: <id>)` if from the rule base. End with a one-line verdict and the count dropped in verification. Then remind: *"After this is reviewed by others, run deep-review **learn** so any miss becomes a permanent rule."*

### RUN options (if the user asks)
- **apply fixes** → after reporting, apply agreed fixes to the working tree.
- **high/max effort** → run more specialists and add a second verifier vote per finding.
- **post comments** → if reviewing a PR, post findings as inline PR comments via `gh`.

---

## § LEARN — mine others' review comments into rules

Takes review feedback others left (CodeRabbit, Copilot, Codex, humans), finds lessons the rule base does **not** cover, distills them into canonical rules. **Exactly two modes — nothing else:**

- **learn (no repo)** → **incremental sweep of ALL tracked repos.** Process every repo in `state.sources` independently, each from its **own cursor** (only comments with `created_at > cursor`).
- **learn `owner/name`** → **(re)learn that one repo from the start** (entire review history), tracked or not. Ignore its cursor, re-mine everything, then reset the cursor to the newest comment. Use to onboard a new repo or rebuild after changing mining prompts. Idempotent: L2's gap analysis reinforces known rules instead of duplicating, and L4 guards id collisions.

There are no PR-number, git-range, NDJSON, `--since`, or `--all` modes.

### L0 — Resolve which source(s)
Read `SKILL_DIR/learnings/state.json` (create if missing — schema in its `_doc`).
- **No repo:** every repo in `state.sources`, window = `created_at > its cursor`. No sources yet → report nothing to sweep, suggest `learn owner/name`, stop.
- **`owner/name`:** that single repo, window = **full history**. Add to `state.sources` if untracked.

Record `run_started_at = date -u +%Y-%m-%dT%H:%M:%SZ` for L5.

> **Multi-source sweep:** with more than one source, run L1–L5 **per source in turn**, then a combined summary. Each source advances its own watermark independently — a failure on one repo never rewinds another. Empty-window sources are reported "caught up" and skipped cheaply.

### L1 — Gather review comments
Page inline review comments and apply the L0 window:
`gh api "repos/{owner}/{name}/pulls/comments?sort=created&direction=desc&per_page=100"` — keep `created_at > cursor` for an incremental sweep, or keep everything for a full re-mine; stop paging once a page is entirely at/older than the cursor (incremental only). Map each to `{pr,id,in_reply_to,user,path,line,commit_id,diff_hunk,body,created_at}`.

Track `comments_seen`. Filter bot-billing/trial noise, walkthrough/summary blocks, and pure acknowledgement replies ("confirmed — fixed", "LGTM", emoji) — but **keep findings even when they contain `<summary>`/severity markup** (CodeRabbit wraps suggestions in those). Dedup by (body, path, pr). Track `comments_processed`. Save cleaned set to `SKILL_DIR/corpus/<repo-slug>/learned-<epoch>.ndjson`.

**Empty window** → report "already caught up — nothing new since {last_checked}", spawn no agents, jump to L5's no-op branch (refresh `last_checked` only).

### L2 — Gap analysis (what we know vs. what they flagged)
Read `SKILL_DIR/learnings/rules.json`. Classify every comment:
- **already-covered** — an existing rule's `detection_hint` would catch it → *reinforced* (bump `support_count`, add PR to `example_prs`). No new rule.
- **new lesson** — no existing rule covers it → candidate new rule.
- **noise** — not reusable (one-off, repo-trivia, taste) → discard, count only.

Cross-check the real before→after: `diff_hunk` is the flagged code; reply threads / merge commit are the fix.

### L3 — Distill + adversarially verify new rules
Merge same-lesson candidates into one canonical rule: `{id, category, title, rule, detection_hint, severity, example_prs, support_count}`. `category` ∈ the 12 specialist categories. `detection_hint` must be actionable (regex/grep, AST shape, or sharp yes/no question). Fresh kebab-case `id`, no collision with existing ids. Verify each candidate (dr-verifier-style): keep only if generalizable, not already caught by linter/compiler, and actionable. Drop the rest.

> For non-trivial corpora (dozens+ comments), do L1–L3 as a background **Workflow** (miners → gap-analysis vs the existing rule digest → verify), as done for the opencode/inkstone/pi bootstraps. For a single PR, inline Task calls are fine.

### L4 — Merge into the knowledge base
1. `SKILL_DIR/learnings/rules.json` — append new rules (collision-guarded ids; tag `source_repo`); bump `support_count`/`example_prs` and append `reinforced_by` for reinforced ones; bump `_meta.version`, add to `_meta.sources`. Back up to `rules.json.bak` first.
2. `python3 SKILL_DIR/build_kb.py` to regenerate `INDEX.md` + `by-category/*.md`.
3. `SKILL_DIR/learnings/CHANGELOG.md` — **append** an entry: date, source, N added, M reinforced, K noise, one-liner per new rule.

Use stable ids; never renumber. A "new" rule that's really a refinement → edit the existing one instead of duplicating.

### L5 — Advance the watermark + report
Update `SKILL_DIR/learnings/state.json` for **each source processed** (independently):
- `cursor` → max `created_at` among that source's processed comments (only advance forward; empty-window branch leaves cursor but refreshes `last_checked`).
- `last_checked` → `run_started_at`. `last_run` → `{comments_seen, comments_processed, new_rules, reinforced, noise}`. `totals` → increment `runs`, add to `new_rules_contributed`/`reinforced_contributed`.

Summarize. Multi-source sweep → one line per source + combined totals + new KB rule count. Single source → detail (comments mined, rules reinforced, new rules by id+title, discarded count, new cursor). Note the next **run** loads the updated rules.

---

## § STATUS — learning watermarks & pending backlog

Read-only. Per source repo: when last checked, the watermark, cumulative rules contributed, and how many review comments appeared **since** (backlog awaiting a `learn` run).

### S1 — Load state
Read `SKILL_DIR/learnings/state.json` (missing → "no learning runs recorded yet; **learn** creates it"). Read KB size from `rules.json` (`_meta` + `len(rules)`).

### S2 — Resolve sources
- a repo named → just that. Else if cwd is a git repo → its `owner/name` first (show "never checked" if untracked), then other tracked sources. Else → all tracked sources.

### S3 — Pending backlog per source
Count comments newer than `cursor` without mining:
`gh api "repos/{o}/{n}/pulls/comments?sort=created&direction=desc&per_page=100" --jq --arg c "<cursor>" '[.[] | select(.created_at > $c)] | length'`.
Full first page all-newer → `100+` (learn pages the rest). No cursor → "never mined — full history pending". Handle `gh` auth/permission errors gracefully.

### S4 — Report
Table, one row per source:

| Source | Last checked | Watermark (cursor) | Pending | Rules contributed |
|---|---|---|---|---|

Then a one-line summary (total rules, sources tracked, who has a backlog). Pending > 0 → suggest `learn <repo>`. All caught up → say so. **Do not mutate `state.json`** — only `learn` advances cursors.

---

## Notes

- **No internal tools, no SaaS** — everything is local `git`/`gh` + the Task tool fanning out to local role prompts. Safe to point at private code; corpus and rules stay inside this skill directory.
- A full **run** (6+ specialists + verification) is a multi-agent fan-out — roughly 250k–600k tokens depending on diff size and effort. Don't kick it off for trivial diffs.
- Tracked sources today: `anomalyco/opencode`, `hongyilyu/inkstone`, `earendil-works/pi`.
- **Self-contained & committable:** everything (rules, state, specialist prompts, build script) is under this directory. Commit it to share the reviewer + its learned rules with the team; no per-machine `~/.claude` setup needed.
