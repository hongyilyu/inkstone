---
name: review-loop
description: >-
  Autonomously resolve CodeRabbit review on an open PR. Waits for CodeRabbit's
  review of the current HEAD, adversarially verifies each finding against the
  live code, fixes the real ones, replies-and-resolves the false positives and
  deferred nits, re-runs the local CI gate, pushes (which re-triggers
  CodeRabbit), and loops until CodeRabbit is clean or a cap is hit. Never merges
  — the merge stays the user's. Use after a PR is opened (e.g. by feature-flow)
  and you want its CodeRabbit comments driven to resolution hands-off.
---

# /review-loop

The autonomous tail of the feature workflow: from "PR is open, CI green" to "CodeRabbit has nothing left to say." `feature-flow` already lands the PR and waits for **CI**; this skill closes the **CodeRabbit** loop that follows.

You are the orchestrator. You spawn verifier subagents in parallel. You apply the confirmed fixes yourself (they're small and come pre-verified with a minimal fix plan; the gate is the backstop). **You never merge to `master` and never push to it** — pushing the *PR branch*, replying to comments, and posting `@coderabbitai review` triggers (via the await step) are the full extent of your write authority.

## Inputs

- A PR number (`/review-loop 187`), or nothing — then infer from the current branch's open PR (`gh pr view --json number`).
- Optional `--max-rounds N` (default 3, matching feature-flow's iteration cap).

## Preconditions (check once, fail fast)

1. PR resolves and is **open**. If closed/merged, stop.
2. Working tree clean (`git status --porcelain` empty). WIP risks a dirty push — stop if not.
3. The local branch tracks the PR's head branch and is **even with or ahead of** `origin` (no unpulled remote commits). If behind, stop — the user has remote work you'd clobber.
4. The local §6 gate is green on the current tip. (If you arrived here straight from feature-flow it just passed; otherwise run [the gate](#the-gate) once before entering the loop, so round 1 starts from a known-green base.)

Record `PR`, `HEAD := git rev-parse HEAD`, and `REPO := owner/name` for the run.

## The round loop

Up to `--max-rounds` rounds (default 3). Each round:

```
1. await   → block until CodeRabbit has reviewed the current HEAD
2. fetch   → pull unresolved, non-outdated CodeRabbit threads
3. verify  → one parallel subagent per actionable finding: real or refuted?
4. fix     → apply the confirmed-real fixes on the PR branch
5. respond → reply on every thread; resolve the refuted/deferred ones
6. gate    → run the local §6 CI mirror; red ⇒ fix before pushing, never push red
7. push    → push the branch (auto-re-triggers CodeRabbit) → next round
```

Termination — the loop exits (and writes the [digest](#terminal-digest)) when **any** holds:

- **Clean.** `fetch` returns zero unresolved CodeRabbit threads at the current HEAD *after a fresh review*. This is the success exit.
- **Quiescent.** A round produced **no code change** — every finding was refuted or deferred, all replied-and-resolved. Nothing to push, so CodeRabbit won't re-review; the conversation is closed. Success exit (deferred nits are listed in the digest).
- **Cap hit.** `--max-rounds` reached with findings still open. Stop and surface — do not keep burning rounds. The open threads go in the digest verbatim.

### 1. await (rate-limit-aware)

CodeRabbit throttles **nearly every PR on this repo** — review-limit windows of 20–50 minutes are the steady state, not an edge case. Two facts make this step the hardest part of the loop:

- **The limit is per-user, not per-PR.** The notice reads "*you've* reached your PR review rate limit" — it's one budget across all your open PRs. So when several PRs are in flight (e.g. you ran feature-flow on a few), they *compete*: a window lifting does **not** guarantee *this* PR gets reviewed — another PR can grab the freed slot and you're re-throttled. Expect to ride out **several** windows for one review.
- **A throttled attempt is dropped, not queued.** Once the window lifts, the review only happens if `@coderabbitai review` is (re-)issued.

Surviving this is the script's whole job, so it lives there, not in prose:

```
node .agents/skills/review-loop/cr.mjs await-review <PR> <HEAD> [maxWaitMin=480] [pollMin=5]
```

It blocks until a `coderabbitai[bot]` review carries `commit_id == HEAD` (the verified "reviewed *this* commit" signal — a stale review of an earlier commit does not count), with a **dynamic** cadence:

- returns ready the moment HEAD is reviewed;
- **when throttled, sleeps the window's actual remaining time** (parsed from CodeRabbit's "available in N minutes and M seconds" notice, +30s buffer, rounded up to the minute) — not a fixed poll. No point waking every 5 min through a 40-min window;
- once not throttled, posts `@coderabbitai review` **exactly once per window** (a lift-gate prevents a fresh trigger every tick), then polls every `pollMin` (default **5 min**) to catch either the review landing or a *fresh* throttle notice (the per-user contention case — re-throttled before our turn), and loops;
- gives one initial nudge when CodeRabbit is on-demand and not throttled.

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

Only unresolved, non-outdated threads authored by CodeRabbit are returned — threads CodeRabbit already auto-resolved (e.g. it confirmed a prior fix) drop out on their own. `count == 0` ⇒ **Clean** exit.

### 3. verify (adversarial — the heart of full-auto)

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

### 6. the gate

Before pushing, the change **must** clear the repo's [§6 CI gate](../../../docs/agents/ci.md) locally — the same four jobs the PR faces (`lint-format`, `ts`, `rust`, `e2e`). A review fix that breaks the gate is a worse regression than the nit it fixed. Run, top to bottom, from the repo root:

- `pnpm install --frozen-lockfile` — only if `pnpm-lock.yaml` changed.
- `pnpm exec biome ci .` — the read-only `lint-format` job (not `pnpm format`, which mutates).
- `pnpm -r --if-present check` then `pnpm -r test` — the `ts` job (workspace tsc + every package's vitest, including contract parity).
- `cargo check --locked --manifest-path crates/core/Cargo.toml`, `cargo test --locked --manifest-path crates/core/Cargo.toml`, then the schema-fixture staleness check (`cargo test … regenerate_schema_fixtures`, `git add -N tests/contract/fixtures/ && git diff --exit-code tests/contract/fixtures/`) — the `rust` job. Skip only if no Rust/protocol file changed this round.
- `pnpm -C apps/web build` (if `apps/web`/`ui-sdk` changed) then `pnpm -C tests/e2e exec playwright install chromium` then `pnpm test:e2e` — the `e2e` job.

Scope the gate to what the round touched (a docs-only fix needs only `biome ci`), but when in doubt run all four — the PR's CI will. **Red gate ⇒ fix it before pushing.** This counts against the round cap; if it can't go green, stop and surface.

### 7. push

```
git push
```

Pushing the new commit re-triggers CodeRabbit on the new HEAD automatically (verified: reviews carry distinct `commit_id`s per push). Update `HEAD := git rev-parse HEAD` and start the next round at step 1. No push happened this round (Quiescent) ⇒ exit instead.

## Terminal digest

When the loop exits, print a short digest (and nothing else — no essay):

```
review-loop: <slug/PR> — <clean | quiescent | cap-hit>

Rounds: <r>
Findings: <total seen> (<fixed> fixed, <refuted> refuted, <deferred> deferred)
Commits pushed: <sha list>
CI after last push: <pass/fail/pending — gh pr checks>

Deferred (replied + resolved, not acted on):
- <path>:<line> — <title> — <reason>

Still open (cap-hit only):
- <path>:<line> — <title>
```

If `cap-hit`, the open threads are real work the user must decide on — surface them plainly, don't bury them.

## The cr.mjs helper

`./cr.mjs` (dependency-free, shells to `gh`) is the read/resolve seam — it keeps the fragile GraphQL thread-join and the HEAD-match poll out of the prose:

```
node cr.mjs findings <pr>                              # unresolved CR threads (JSON, parsed + classified)
node cr.mjs await-review <pr> <sha> [maxWaitMin=120] [pollMin=5]  # block until CR reviewed <sha>, surviving throttle; exit 1 on timeout
node cr.mjs resolve <threadId>                          # resolve one thread
```

`await-review` owns the `@coderabbitai review` trigger (once per rate-limit window) — don't post it yourself. Per-thread replies are plain `gh api … /replies` calls (shown inline above); they didn't warrant wrapping.

## Composing with feature-flow

`feature-flow` ends at **CI green → `REPORT.md` → done**; the merge is yours. This skill is the natural next step: once feature-flow reports the PR URL, run `/review-loop <pr>` to drive CodeRabbit to resolution before you merge. They're deliberately separate skills — feature-flow's "done" is a clean CI, review-loop's "done" is a quiet CodeRabbit, and **neither merges**. Chain them by hand, or invoke review-loop as the last step of your "don't stop until done" goal.

## Rules

- **Never merge, never touch `master`.** Push the PR branch, reply, resolve. The merge is the user's.
- **Verify before fixing.** No finding is applied without a code-grounded `real` verdict. Skepticism is the default; CodeRabbit is an input, not an authority.
- **Gate before every push.** Never push a red tree. A broken review-fix is a regression.
- **Every thread gets a response.** Fixed → "Addressed in <sha>"; refuted/deferred → reason + resolve. Nothing dropped silently.
- **Respect the cap.** Findings open at the cap are surfaced, not churned. Three rounds that don't converge is a signal for the user, not a reason for a fourth.
- **Stay in scope.** A review fix that expands the PR's behavior or refactors unrelated code is out of bounds — defer it with a reason.
