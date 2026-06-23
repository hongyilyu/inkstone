---
name: review-loop
description: >-
  Autonomously drive a change to a clean review. Phase 0 (pre-PR): run a local
  dual-engine review — deep-review AND thermo-nuclear-code-quality-review, each
  across BOTH Claude (subagents) and the cross engine (Codex/Claude via CLI) —
  verify findings, fix the real ones, and loop until both engines and both
  reviews are clean, THEN open the PR. Phase 1 (post-PR): wait for CodeRabbit's
  auto-review of the current HEAD (a fallback `@coderabbitai review` nudges it if
  it stalls), adversarially verify each finding, fix, reply/resolve, re-run the
  CI gate, push, and loop until clean or a cap. Never merges — the merge stays
  the user's. Use to take an
  open change all the way to "every reviewer is quiet."
---

# /review-loop

The autonomous tail of the feature workflow, in two phases:

- **Phase 0 — local pre-PR review (dual-engine).** Before the change is even pushed for review, run BOTH local reviewers — `deep-review` (correctness/bug fan-out) and `thermo-nuclear-code-quality-review` (strict maintainability/structure) — and run each across BOTH engines: the engine you're running as (via parallel subagents) and the *cross* engine (the other one, via its CLI). Verify, fix, re-run, and loop until **every reviewer on both engines is clean**. Then open the PR.
- **Phase 1 — post-PR CodeRabbit loop.** From "PR is open, CI green" to "CodeRabbit has nothing left to say": await CodeRabbit's review of HEAD, adversarially verify, fix, reply/resolve, gate, push, loop.

You are the orchestrator. You spawn verifier/reviewer subagents in parallel and spawn the cross-engine reviewer via its CLI. You apply the confirmed fixes yourself (small, pre-verified, gate-backed). **You never merge to `master` and never push to it** — pushing the *PR branch*, replying to comments, and posting `@coderabbitai review` triggers (via the await step) are the full extent of your write authority.

## Inputs

- A PR number (`/review-loop 187`) to start at Phase 1 directly (PR already open), or nothing — then run Phase 0 on the current branch's local diff first. With no arg, resolve any existing PR for the branch up front (`PR=$(gh pr view --json number -q .number 2>/dev/null)`); Phase 0's [Open the PR](#open-the-pr) step (re)captures `PR` before Phase 1 either way.
- Optional `--max-rounds N` (default 3, matching feature-flow's iteration cap) — applies to *each* phase independently.
- Optional `--skip-phase0` to jump straight to the CodeRabbit loop (e.g. the local review already ran this session).

## The gate (shared by both phases)

Before every push (Phase 1) or fix-round commit (Phase 0), the change **must** clear the repo's [§6 CI gate](../../../docs/agents/ci.md) locally — the same four jobs the PR faces (`lint-format`, `ts`, `rust`, `e2e`). A review fix that breaks the gate is a worse regression than the finding it fixed. Run, top to bottom, from the repo root:

- `pnpm install --frozen-lockfile` — only if `pnpm-lock.yaml` changed.
- `pnpm exec biome ci .` — the read-only `lint-format` job (not `pnpm format`, which mutates).
- `pnpm -r --if-present check` then `pnpm -r test` — the `ts` job (workspace tsc + every package's vitest, including contract parity).
- `cargo check --locked --manifest-path crates/core/Cargo.toml`, `cargo test --locked --manifest-path crates/core/Cargo.toml`, then the schema-fixture staleness check (`cargo test … regenerate_schema_fixtures`, `git add -N tests/contract/fixtures/ && git diff --exit-code tests/contract/fixtures/`) — the `rust` job. Skip only if no Rust/protocol file changed this round.
- `pnpm -C apps/web build` (if `apps/web`/`ui-sdk` changed) then `pnpm -C tests/e2e exec playwright install chromium` then `pnpm test:e2e` — the `e2e` job.

Scope the gate to what the round touched (a docs-only change needs only `biome ci`), but when in doubt run all four — the PR's CI will. **Red gate ⇒ fix it before pushing/committing.** This counts against the round cap; if it can't go green, stop and surface.

## Termination conditions (shared by both phases)

Each phase's round loop exits when **any** holds. The vocabulary is the same; only the per-phase action differs (Phase 0 *opens the PR*, Phase 1 *stops pushing*):

- **Clean.** A fresh review round returned **zero** confirmed-real findings AND applied no code change. Success exit.
- **Quiescent.** A round produced no code change because every remaining finding was either refuted or a deferred **nit** (with a reason). A deferred finding that is a confirmed-**real** issue (correct but out-of-scope) does **not** make a round quiescent — it's an open real finding, so the loop is `cap-hit`, not a success. Success exit; deferred nits go in the digest.
- **Cap hit.** `--max-rounds` reached with confirmed-real findings still open (unfixed or deferred-real), OR the final round still applied fixes that were never re-reviewed → stop and surface; do **not** treat as clean. (Phase 0 cap-hit ⇒ do **not** open the PR over an open/deferred-real finding.)

> The cap applies to each phase independently. A round that applies a fix is not a clean exit — you must re-review the post-fix diff; "clean" requires a review round that changed nothing.

## Phase 0 — local pre-PR review (dual-engine, dual-reviewer)

Run this **before** opening the PR (skip with `--skip-phase0`, or when invoked with an already-open PR number and the local review already ran). The goal: no avoidable finding survives to CodeRabbit. The change gets two *kinds* of review — `deep-review` (correctness) and `thermo-nuclear-code-quality-review` (maintainability) — from two *engines* (yours + the cross engine, see [Spawning the reviewers](#spawning-the-reviewers-phase-0)), and you loop until all four reviewer streams are quiet.

### Phase-0 preconditions

1. On a feature branch (not `master`). The diff under review must be **committed** — if there are uncommitted edits you intend to ship, commit them first, *then* proceed (unlike Phase 1's clean-tree gate, a dirty tree here is a commit-then-continue step, not a stop).
2. If the branch already has an upstream, it must be **even with or ahead of** it (same divergence guard as Phase 1 precondition 3) — review-fix commits on a stale branch would clobber remote work at push time. Behind ⇒ stop.
3. [The gate](#the-gate-shared-by-both-phases) is green on the current tip — review a green base, not a broken one.
4. Resolve `BASE` (the branch point, default `origin/master`) and capture the diff once: `git diff $BASE...HEAD`. **Empty diff** ⇒ nothing to review: if a PR is already open, go straight to Phase 1; otherwise there's nothing to review *or* open — stop and say so.

### The Phase-0 round loop

Up to `--max-rounds` (default 3). Each round: **review** (all four streams concurrently against the current diff) → **verify** ([same adversarial discipline as Phase 1's verify step](#3-verify-adversarial-the-heart-of-full-auto): dedup across streams, confirm each finding against the live code, drop false positives, defer out-of-scope ones with a reason) → **fix** (apply confirmed-real in-scope fixes; pin behavior changes with tests) → [**gate**](#the-gate-shared-by-both-phases) → **commit** (`review-fix: address local review (round <r>)`). Then re-run all four streams on the new diff — a reviewer raising a *new* finding about a fix you just made is expected, and is why we loop.

The four streams (see [Spawning the reviewers](#spawning-the-reviewers-phase-0) for how to run them on each engine):

| # | reviewer | engine |
|---|---|---|
| a | deep-review | yours (subagents) |
| b | thermo-nuclear | yours (subagents) |
| c | deep-review (rubric) | cross engine (CLI) |
| d | thermo-nuclear (rubric) | cross engine (CLI) |

Exit per the [shared termination conditions](#termination-conditions-shared-by-both-phases) (clean / quiescent → open the PR; cap-hit → stop, do not open the PR).

### Open the PR

On a clean/quiescent Phase 0, push the branch, then resolve the PR — **capture its number into `PR`**, which Phase 1 needs for `await-review`/`findings`:

- **No PR yet:** create one **non-interactively** (bare `gh pr create` prompts and will hang an autonomous run). Write the dual-engine review summary (found / fixed / deferred) to a file and pass it:
  `git push -u origin HEAD && gh pr create --title "<subject>" --body-file <summary> && PR=$(gh pr view --json number -q .number)`
- **PR already open for the branch:** `git push`, then `PR=$(gh pr view --json number -q .number)`. CodeRabbit auto-reviews the new HEAD on push; Phase 1's `await-review` step waits for that review (and posts a fallback `@coderabbitai review` if it stalls).

Then continue into **Phase 1** with that `PR`.

## Phase 1 — CodeRabbit loop

### Preconditions (check once, fail fast)

1. PR resolves and is **open**. If closed/merged, stop.
2. Working tree clean (`git status --porcelain` empty). WIP risks a dirty push — stop if not.
3. The local branch tracks the PR's head branch and is **even with or ahead of** `origin` (no unpulled remote commits). If behind, stop — the user has remote work you'd clobber.
4. [The gate](#the-gate-shared-by-both-phases) is green on the current tip. (If you arrived here straight from Phase 0 / feature-flow it just passed; otherwise run it once before entering the loop, so round 1 starts from a known-green base.)

Record `PR`, `HEAD := git rev-parse HEAD`, and `REPO := owner/name` for the run.

### The CodeRabbit round loop

Up to `--max-rounds` rounds (default 3). Each round:

```
1. await   → block until CodeRabbit has reviewed the current HEAD
2. fetch   → pull unresolved, non-outdated CodeRabbit threads
3. verify  → one parallel subagent per actionable finding: real or refuted?
4. fix     → apply the confirmed-real fixes on the PR branch
5. respond → reply on every thread; resolve the refuted/deferred ones
6. gate    → run the local §6 CI mirror; red ⇒ fix before pushing, never push red
7. push    → push the branch → next round (the push auto-triggers CodeRabbit; the round's `await` step also posts a fallback `@coderabbitai review` if it stalls)
```

Exit per the [shared termination conditions](#termination-conditions-shared-by-both-phases), read against CodeRabbit threads: **clean** = `fetch` returns zero unresolved threads at HEAD after a fresh review; **quiescent** = a round produced no code change (every thread refuted/deferred + resolved, nothing to push, so CodeRabbit won't re-review); **cap-hit** = `--max-rounds` reached with threads still open (surfaced in the digest verbatim). On exit, write the [digest](#terminal-digest).

### 1. await (rate-limit-aware)

CodeRabbit throttles **nearly every PR on this repo** — review-limit windows of 20–50 minutes are the steady state, not an edge case. Two facts make this step the hardest part of the loop:

- **The limit is per-user, not per-PR.** The notice reads "*you've* reached your PR review rate limit" — it's one budget across all your open PRs. So when several PRs are in flight (e.g. you ran feature-flow on a few), they *compete*: a window lifting does **not** guarantee *this* PR gets reviewed — another PR can grab the freed slot and you're re-throttled. Expect to ride out **several** windows for one review.
- **A throttled attempt is dropped, not queued.** Once the window lifts, the review only happens if `@coderabbitai review` is (re-)issued.

Surviving this is the script's whole job, so it lives there, not in prose:

```
node .agents/skills/review-loop/cr.mjs await-review <PR> <HEAD> [maxWaitMin=480] [pollMin=5]
```

CodeRabbit **auto-reviews** on this repo — a push or opening the PR triggers a review on its own. `await-review` recognizes completion via **two** signals (whichever lands first), so it doesn't hang waiting for the wrong one:

1. a `coderabbitai[bot]` **review object** with `commit_id == HEAD` — emitted when CodeRabbit leaves inline thread comments (a stale review of an earlier commit does not count);
2. a CodeRabbit **walkthrough / summary issue-comment that names HEAD's SHA** — this is how a **clean** review reports ("*No actionable comments were generated in the recent review.* 🎉"); on a clean pass CodeRabbit posts **no** review object, only this inline comment. Its "Commits … between `<base>` and `<head>`" line carries the reviewed head. **A clean review is an inline comment, not a review object** — without this signal the loop would spin forever on a clean PR.

`await-review` still posts `@coderabbitai review` (don't post it yourself), but now as a **fallback nudge** — the auto-review usually lands first; the explicit trigger covers a paused auto-review or a re-push that needs poking. CodeRabbit will reply "*does not re-review already reviewed commits*" if it already reviewed HEAD, which is itself a confirmation. The cadence is **dynamic**:

- returns ready the moment either signal shows HEAD is reviewed;
- **when throttled, sleeps the window's actual remaining time** (parsed from CodeRabbit's "available in N minutes and M seconds" notice, +30s buffer, rounded up to the minute) — not a fixed poll. No point waking every 5 min through a 40-min window;
- once not throttled, posts the fallback `@coderabbitai review` trigger **exactly once per window** (a lift-gate prevents a fresh trigger every tick), then polls every `pollMin` (default **5 min**) to catch either the review landing or a *fresh* throttle notice (the per-user contention case — re-throttled before our turn), and loops;
- posts the fallback trigger immediately on entry when there's no active throttle.

`maxWaitMin` defaults to **480 (8h)** precisely because riding out several contended windows is the expected case — set it higher for a busy multi-PR day; it's a backstop against a genuinely dead CodeRabbit, not a normal exit.

**Run it backgrounded.** A single throttle sleep alone exceeds the foreground Bash 10-min cap, so launch with `run_in_background: true` and read its output when it re-invokes you on exit; each state change logs to stderr (so a long silent sleep is expected, not a hang). `ready:true` ⇒ proceed to fetch. `ready:false` (hit `maxWaitMin`) ⇒ CodeRabbit is down or the limit never cleared for this PR — stop, record "CodeRabbit unavailable" in the digest. Don't loop blindly.

### 2. fetch

```
node .agents/skills/review-loop/cr.mjs findings <PR>
```

Returns `{ head, count, actionable, threads[] }`. Each thread:

| field | meaning |
|---|---|
| `threadId` | GraphQL id — pass to `cr.mjs resolve` |
| `commentId` | REST id — reply target |
| `path`, `line` | where the finding points |
| `kind` | `issue` \| `refactor` \| `minor` \| `nit` \| `other` (parsed from CodeRabbit's badge line) |
| `actionable` | `true` for `issue`/`refactor` — these get verified; `false` (nits/minor) are advisory |
| `title` | the bolded one-line summary |
| `suggestedDiff` | CodeRabbit's proposed patch, if any |
| `aiPrompt` | CodeRabbit's "🤖 Prompt for AI Agents" block — its own fix instructions |
| `body` | full markdown, for the verifier |

Only unresolved, non-outdated threads authored by CodeRabbit are returned — threads CodeRabbit already auto-resolved (e.g. it confirmed a prior fix) drop out on their own. `count == 0` ⇒ **Clean** exit. A clean review reports as a walkthrough comment ("*No actionable comments were generated* 🎉") with **no threads** — `await-review` already returned ready off that comment, so `count == 0` here is the expected clean state, not a "didn't review yet" ambiguity.

### 3. verify (adversarial: the heart of full-auto)

CodeRabbit is good but not authoritative: it raises stale findings (already fixed in a later commit), false positives, and style nits dressed as issues. **Never apply a finding blind.** This repo's history is full of CodeRabbit findings that were correctly *refuted* on inspection (e.g. `CSS.escape` valid, `scrollIntoView`-restore unnecessary under the test's isolation).

Spawn **one verifier subagent per `actionable` finding, in parallel** (single message, multiple `Agent` calls; or a `Workflow` fan-out if the batch is large). Each verifier:

- Reads the **current** code at `path` around `line` — plus enough context (the function, the `afterEach`/test-isolation setup, the type it references) to judge whether the issue *actually reproduces at this HEAD*.
- Renders a verdict, biased toward skepticism but grounded in the code (not "default refuted"):
  - **`real`** — reproduces now. Returns a **minimal** fix plan: exact file, lines, and the smallest change that resolves it. CodeRabbit's `suggestedDiff`/`aiPrompt` is a starting point, not gospel — the verifier owns correctness and scope.
  - **`refuted`** — does not reproduce / is wrong / is already handled. Returns a one-sentence reason citing the code (this becomes the reply).
- Stays in scope: a `real` fix must not expand the PR's behavior or touch files unrelated to the finding. If the only correct fix is out of scope, verdict is `real` but **`defer`** with a reason — record it, don't act this round.

`nit`/`minor` (non-actionable) findings skip verification and are treated as **deferred** by default — replied-and-resolved with a brief "nit — not blocking" unless one is trivially correct *and* in-scope, in which case promote it to the fix set.

Give each verifier a structured envelope so verdicts come back parseable:

```
ROLE:        verify-finding
PR:          <PR>
FINDING:     <path>:<line> — <title>
KIND:        <kind>
BODY:        <full thread body>
TASK:        Read the CURRENT code. Decide real | refuted | defer. If real, give the
             minimal in-scope fix (file, lines, change). If refuted/defer, give the
             one-sentence reason, citing the code. Output the verdict block only.
```

### 4. fix

Apply every `real` (non-deferred) fix on the PR branch, in the orchestrator's checkout. Keep each change minimal and traceable to its finding. Group them into one commit per round:

```
git commit -m "review-fix: address CodeRabbit (round <r>) — <n> findings"
```

(`review-fix:` mirrors feature-flow's `final-fix:` prefix; the PR's reviewer can still walk slice commits beneath it.) If a round confirms zero `real` fixes, make no commit — that's the **Quiescent** path.

### 5. respond

Every fetched thread gets a response — nothing is silently dropped (the same address-or-reason discipline feature-flow uses for its reviewers):

- **Fixed:** reply `Addressed in <short-sha>.` Do **not** manually resolve — let CodeRabbit confirm on its next review (if your fix missed, it reopens, which you want). Replies use the REST id:
  `gh api repos/<REPO>/pulls/<PR>/comments/<commentId>/replies -f body='Addressed in <sha>.'`
- **Refuted:** reply with the verifier's one-sentence reason, then resolve the thread:
  reply (as above), then `node .agents/skills/review-loop/cr.mjs resolve <threadId>`.
- **Deferred (nit / out-of-scope real):** reply with the reason ("nit — not blocking" or "out of scope for this PR: <why>"), then resolve.

### 6. gate

Before pushing, run [the gate](#the-gate-shared-by-both-phases). **Red ⇒ fix before pushing, never push red.**

### 7. push

```
git push
```

Pushing the new commit auto-triggers a fresh CodeRabbit review of the new HEAD; the next round's `await` step (step 1) waits for it (matching on the new HEAD's SHA via either signal — review object `commit_id` or walkthrough comment — so a stale review of the prior commit doesn't satisfy it), and posts a fallback `@coderabbitai review` if the auto-review stalls. Update `HEAD := git rev-parse HEAD` and start the next round at step 1. No push happened this round (Quiescent) ⇒ exit instead.

## Terminal digest

When the run exits, print a short digest covering both phases (and nothing else — no essay):

```
review-loop: <slug/PR> — <clean | quiescent | cap-hit>

Phase 0 (local dual-engine):
  Rounds: <r>
  Reviewers: deep-review + thermo-nuclear × {<your-engine>, <cross-engine>}
  Findings: <total> (<fixed> fixed, <refuted> refuted, <deferred> deferred)
  Cross-engine catches: <n notable findings the cross engine raised>
# Phase 1 + CI lines ONLY if a PR exists (Phase 1 ran). Omit this whole block
# on a Phase-0 cap-hit (no PR was opened).
Phase 1 (CodeRabbit):
  Rounds: <r>
  Findings: <total> (<fixed> fixed, <refuted> refuted, <deferred> deferred)
  Commits pushed: <sha list>
  CI after last push: <pass/fail/pending — gh pr checks>

Deferred (resolved, not acted on):
- <path>:<line> — <title> — <reason>

Still open (cap-hit only):
- <path>:<line> — <title>
```

The status line is the *terminal* phase's outcome. If `cap-hit` in either phase, the open findings are real work the user must decide on — surface them plainly, don't bury them. Omit a phase's block when it didn't run: skipped Phase 0 (`--skip-phase0` or a PR-number start) ⇒ omit the Phase 0 block; Phase 0 ended `cap-hit` (no PR opened) ⇒ status is `cap-hit`, omit the Phase 1 block and `CI after last push`.

## The cr.mjs helper

`cr.mjs` (dependency-free, shells to `gh`) is the read/resolve seam — it keeps the fragile GraphQL thread-join and the HEAD-match poll out of the prose. Invoke it by its full path from the repo root (matching the phase steps above):

```
node .agents/skills/review-loop/cr.mjs findings <pr>                              # unresolved CR threads (JSON, parsed + classified)
node .agents/skills/review-loop/cr.mjs await-review <pr> <sha> [maxWaitMin=480] [pollMin=5]  # block until CR reviewed <sha>, surviving throttle; exit 1 on timeout
node .agents/skills/review-loop/cr.mjs resolve <threadId>                          # resolve one thread
```

`await-review` owns the fallback `@coderabbitai review` trigger (once per rate-limit window) — don't post it yourself; it also detects the auto-review's completion (review object or walkthrough comment naming HEAD). Per-thread replies are plain `gh api … /replies` calls (shown inline above); they didn't warrant wrapping.

## Spawning the reviewers (Phase 0)

The two reviewers are the bundled skills `deep-review` (correctness) and `thermo-nuclear-code-quality-review` (maintainability). You know which engine you are from your own runtime identity; if genuinely unsure, probe (`command -v codex` / `command -v claude`) and use the CLI you can invoke as the *cross* engine. Run each reviewer on **both** engines:

| You are | Same-engine pass (loads the skill) | Cross-engine pass (rubric ported into the CLI prompt) |
|---|---|---|
| **Claude Code** | parallel `Agent`/`Task` subagents (or a `Workflow` fan-out), each invoking the bundled skill on the diff | `codex exec -s read-only --skip-git-repo-check -o <out> "<task>"` — headless; read the verdict from `<out>` |
| **Codex** | subagents invoking the bundled skill on the diff | `claude -p "<task>"` — print mode; capture stdout |

The same-engine pass can load the bundled skill by name; the cross engine can't (the skills are Claude-bundled), so its `<task>` **carries the rubric text inline** — that's why the cross-engine streams are "rubric" passes, not skill invocations. Each `<task>` is self-contained: the ported rubric (deep-review's correctness lens, or thermo-nuclear's strict-maintainability rubric), the diff to review (the `git diff $BASE...HEAD` [captured in the Phase-0 preconditions](#phase-0-preconditions)), the scope rule (*only this diff; ignore pre-existing issues it merely sits near*), and the output contract (`file:line · severity · problem · minimal fix`).

Spawn all four streams in one batch, but run the cross-engine CLI **backgrounded** — a large diff makes `codex exec` / `claude -p` slow (minutes), and the same-engine subagents shouldn't block on it; read its output when it returns. Pass the cross-engine review a strict review-only instruction (it must not edit files); `codex exec -s read-only` enforces this for Codex.

**A stream must SUCCEED to count.** A cross-engine CLI that errored, timed out, hit an auth/rate problem, or produced no parseable verdict has **not reviewed** — it is *not* a clean stream. Confirm each stream returned a real verdict (CLI exit 0 + a findings block, even if "no issues"); if a stream failed, re-run it before judging termination. A failed reviewer never counts as zero findings — otherwise the loop could declare Clean having skipped the mandatory second-engine pass. When all four return successfully, dedup, verify, and fix as one set.

> The cross-engine pass is not optional flourish. A second model reviewing the first model's work (including its review-fixes) is where the highest-value, least-expected findings come from — keep both engines in every Phase-0 round.

## Composing with feature-flow

`feature-flow` ends at **CI green → `REPORT.md` → done**; the merge is yours. This skill is the natural next step. Run `/review-loop` while the change is still local (before the PR) to get Phase 0's dual-engine review first, then it opens the PR and drives CodeRabbit (Phase 1) to resolution — or run `/review-loop <pr>` against an already-open PR to start at Phase 1. They stay deliberately separate skills — feature-flow's "done" is a clean CI, review-loop's "done" is *every* reviewer quiet (local dual-engine + CodeRabbit), and **neither merges**.

## Rules

- **Never merge, never touch `master`.** Push the PR branch, reply, resolve. The merge is the user's.
- **Both engines, both reviews, in Phase 0.** deep-review AND thermo-nuclear, each on your engine (subagents) AND the cross engine (`codex exec` / `claude -p`). Don't drop the cross-engine pass to save time — it's the part that catches what you'd rationalize.
- **Loop until quiet, both phases.** Re-run the reviewers after each fix round; a reviewer raising a new finding about your fix is expected. Phase 0 exits only on a clean/quiescent full round; Phase 1 only on a clean/quiescent CodeRabbit pass.
- **Verify before fixing.** No finding is applied without a code-grounded `real` verdict. Skepticism is the default; every reviewer (CodeRabbit, deep-review, thermo-nuclear, the cross engine) is an input, not an authority.
- **Gate before every push/commit.** Never leave a red tree. A broken review-fix is a worse regression than the finding it fixed.
- **Every finding gets a resolution.** Phase 1 thread: Fixed → "Addressed in <sha>"; refuted/deferred → reason + resolve. Phase 0 finding: fixed, refuted (reason), or deferred (reason in the digest). Nothing dropped silently.
- **Respect the cap (per phase).** Findings open at the cap are surfaced, not churned. Rounds that don't converge are a signal for the user, not a reason for one more.
- **Stay in scope.** A review fix that expands the change's behavior or refactors unrelated code is out of bounds — defer it with a reason.
