---
name: feature-flow
description: End-to-end feature delivery for inkstone. Pass anything — a vague request, a half-formed plan, or an existing FEATURE-PLAN.md path. The skill grills the user as needed to produce a runnable plan, then autonomously executes it as a stack of vertical slices (per slice: decompose, optional contract, impl, review, verify, stack). Use when the user wants to build, design, or deliver a feature.
---

# /feature-flow

Two phases. **Intake** (interactive — turns whatever the user provided into a runnable `FEATURE-PLAN.md`) and **slice loop** (autonomous — stacks slices, no user input until done or blocked).

You are the orchestrator. You spawn subagents during the slice loop. You do not implement code yourself.

Inputs:
- A user request. Could be: a paragraph, a half-formed plan, an existing path to `.agents/runs/<slug>/FEATURE-PLAN.md`, or just a feature name.

Outputs (in `.agents/runs/<slug>/`):
- `FEATURE-PLAN.md` — written by intake, read-only after slice loop starts
- `STATE.md` — append-only log
- `slices/<n>/` — per-slice artifacts
- `REPORT.md` on success / `BLOCKED.md` on failure / `SUMMARY.md` always

Worktrees are created by the `Agent` tool with `isolation: "worktree"`. Record paths in `STATE.md`.

See [ARTIFACTS.md](ARTIFACTS.md) for the per-slice file layout and STATE.md format.

## Intake phase (interactive)

Before any slice runs, you need a runnable `FEATURE-PLAN.md`. The user may have given you any of:

- An existing path: `.agents/runs/<slug>/FEATURE-PLAN.md` already exists. **Load and validate.** If it parses against the template, skip to "Confirm before running."
- A slug only: assume the path above; if it exists, load; if not, treat as a new feature and start grilling.
- A vague request, paragraph, or feature name: start grilling from scratch.

You are *deciding*, not implementing. The hardest decision is **slicing** — splitting the feature into a stack of small, vertical, end-to-end-testable increments.

### Process

1. **Locate context.** Read `CONTEXT.md` and the `docs/adr/` index. Skim ADR filenames; open one only when its topic comes up.

2. **Grill until the template is fillable.** Run a `grill-with-docs`-style session, **one question per turn**:
   - Challenge fuzzy terms against `CONTEXT.md`.
   - For each design branch, recommend an answer, ask one question, wait for the reply.
   - Stress-test with concrete scenarios.
   - Cross-reference proposed behavior against ADRs. **If the feature contradicts an existing ADR, the user must decide before continuing**: supersede, amend, or change the feature to conform.
   - Update `CONTEXT.md` inline as terms are resolved.
   - **Author or update ADRs inline** when a new architectural decision crystallizes (triple-test: hard-to-reverse + surprising-without-context + real-trade-off). Write `docs/adr/<NNNN>-<kebab-title>.md` now, with the user. ADRs are planning artifacts; impl agents may not write them later.

3. **Decide components touched.** Core (`crates/core`), Worker (`packages/worker`), UI (`apps/web` + `packages/ui-sdk`), Test Harness (`tests/**`).

4. **Decide contract delta.** Does `packages/protocol` change? If yes, which slice introduces the change?

5. **Check test-infra status per touched component.** For each touched component, note whether test infrastructure exists today. If infra is missing in a component the feature substantially modifies, the first slice for that component should bootstrap it. The user may push back; follow their judgment.

6. **Slice the feature.** This is the hardest step.

   A slice is the smallest piece that is:
   - **End-to-end testable**: at least one test exercising observable behavior through a public interface.
   - **Vertical**: built and verified standalone, without later slices.
   - **Stackable**: each slice's branch is the parent of the next.

   How to slice:
   - Walk from the user's perspective. What's the first observable change a user could see, even if incomplete? That's slice 1.
   - For each slice, name the **single behavior** it proves. Using "and" to describe a slice means it's two slices.
   - Order matters. Earlier slices scaffold what later slices need.
   - Most slices touch one component. Some touch two. None should touch four.
   - Slices cap at ~150–250 lines of diff. Bigger means split.
   - Earlier slices may produce intermediate behavior that's "good enough for now" — fine, as long as the slice's test asserts what *it* was supposed to prove.

   Anti-patterns:
   - **Horizontal**: "slice 1 = all schemas, slice 2 = all backend, slice 3 = all UI." Each is untestable alone. Reject.
   - **One-test-per-method**: a slice per implementation file. Reject.
   - **Untestable scaffolding slice**: "set up the package with empty stubs." Bundle into the first behavioral slice.

7. **For each slice:** title, behavior proven, components, contract delta, RED test (one-line description), notes.

   **Two-component slices need an explicit `Order:` line.** Producer goes first. Example: Core's RED test asserts "GET / returns the Web bundle"; UI is producer, Core is consumer, UI runs first.

8. **Read the slice list back. Get explicit sign-off** before saving.

9. **Confirm ADRs are written.** Every ADR you decided to author/amend exists at its declared path on disk.

10. **Write `FEATURE-PLAN.md`** to `.agents/runs/<slug>/FEATURE-PLAN.md` using the template below.

### FEATURE-PLAN.md template

```md
# Feature: {{title}}

Slug: {{slug}}
Status: ready-for-flow

## Goal

{{One paragraph. What the user can do after this ships. From the user's perspective.}}

## Components touched

- [ ] Core (`crates/core`)
- [ ] Worker (`packages/worker`)
- [ ] UI (`apps/web`, `packages/ui-sdk`)
- [ ] Test Harness (`tests/**`)

## Test-infra status

- {{component}}: {{has infra | bootstrapping in slice <n> | not bootstrapped, carve-out applies}}

## Slices

### Slice 1: {{short title}}

- **Behavior proven:** {{single observable behavior}}
- **Components:** {{Core | Worker | UI | Harness | Contract}} (one, sometimes two)
- **Order (two-component only):** {{<component>-first}} — producer first
- **Contract delta:** {{No change. | Adds: ...}}
- **RED test:** {{one-line test description}}
- **Notes:** {{cross-slice deps, intermediate-state rationale, etc.}}

### Slice 2: {{...}}
...

## Acceptance criteria (feature-level)

- [ ] {{criterion}}

## ADRs to consult

- `docs/adr/NNNN-<title>.md`: {{why this constrains the feature}}

## ADRs authored alongside this plan

- `docs/adr/NNNN-<title>.md`: {{one-line summary}}

(If empty: this feature didn't surface a new architectural decision.)

## Out of scope

- {{thing}}

## Open questions

(Empty if everything is resolved. Anything here that affects slice execution is a blocker — resolve before declaring ready-for-flow.)
```

### Validating an existing plan

If the user pointed at an existing FEATURE-PLAN.md:

1. Check `Status: ready-for-flow`.
2. Check every section in the template is present and filled (no `{{placeholders}}`).
3. Check every path in `## ADRs to consult` and `## ADRs authored alongside this plan` exists on disk.
4. Check every slice has: behavior, components, RED test. Two-component slices have `Order:`.
5. Check `## Open questions` either is empty or contains nothing that affects slice execution. If a question affects execution, it's a blocker — grill the user to resolve before continuing.

If anything is missing, grill to fill it. Don't run with placeholders.

### Confirm before running

Read the slice list back briefly:

> Plan ready at `.agents/runs/<slug>/FEATURE-PLAN.md`. <N> slices: <one-line per slice>. Run it?

Wait for explicit go-ahead. Then proceed to Phase 0.

### Rules

- One question per turn during grilling. No bundles.
- Don't write the plan until the slice list is concrete and the user has signed off.
- Each slice's RED test must be a real, runnable test — not "verify that X works."
- If you can't slice the feature into vertical pieces, the feature is too big or the architecture is wrong. Stop and surface — don't ship a horizontally-sliced plan.

## The slice loop

The plan defines an ordered list of slices: `slice-1`, `slice-2`, ..., `slice-N`. Each slice is a small, end-to-end-testable piece of the feature.

Branch model:

```
master
└── flow/<slug>/slice-1     ← off master
    └── flow/<slug>/slice-2  ← off slice-1
        └── ...
            └── flow/<slug>/slice-N  ← off slice-(N-1)
```

The whole stack only merges to `master` when slice-N passes — and even then, it's the user who merges, not you.

For each slice, in order:

```
0. base       → confirm parent branch (slice-(n-1) or master for slice-1)
1. decompose  → confirm component(s), files, contract delta for this slice
2. contract   → if needed; sequential, blocks impl
3. impl       → 1 (usually) or 2 (rarely) impl agents — see "Slice parallelism" below
4. review     → 4 reviewers in parallel, each in own worktree
5. verify     → run gates on the slice's branch
6. gate       → all green + advisories triaged? proceed to slice-(n+1).
                Any fail or unhandled-reasonable-advisory? loop slice (cap 3).
```

After slice-N's gate passes, the **Final review phase** runs once over the whole stack: feature-level gates (full e2e suite, full Rust tests) and feature-level reviewers. Only then is `REPORT.md` written and the stack handed off.

Slice failures don't block other slices from being attempted **only if** the failure is contained — which it almost never is, since slices stack. In practice: a slice that fails its retry cap halts the whole flow.

## Phase 0: setup (once per flow)

Intake already validated the plan and received user sign-off. This phase is mechanical setup:

1. Verify working tree clean: `git status --porcelain`. If not, stop — don't risk WIP.
2. Confirm `master` is the base branch.
3. The run directory `.agents/runs/<slug>/` already exists (intake created it). Init `STATE.md`.
4. Capture the flow's base SHA: `FEATURE_BASE := $(git rev-parse master)`. Record it in `STATE.md` alongside the `started` event — the Final review phase reads it from there.
5. Append `started` to `STATE.md`.

## Subagent prompt envelope

Every subagent (impl or reviewer) you spawn must receive a structured prompt block at the top with these fields. The SOPs assume these are present.

```
SLUG:           <slug>
SLICE:          <n>
ITERATION:      <m>
ROLE:           <core|worker|ui|harness|contract|review-correctness|review-integration|review-tests|review-adr>
RUN_DIR:        <absolute path to .agents/runs/<slug>/>
SLICE_DIR:      <absolute path to .agents/runs/<slug>/slices/<n>/>
PARENT_SHA:     <SHA of the slice's parent branch tip — master for slice-1, slice-(n-1)'s tip otherwise>
SLICE_BASE:     <PARENT_SHA — the SHA the diff is computed against; use this for `git diff <SLICE_BASE>..HEAD` and `git log <SLICE_BASE>..HEAD`>
SLICE_BRANCH:   flow/<slug>/slice-<n>[-iter<m>]    (the branch the agent is on)
OUTPUT_PATH:    <absolute path the agent writes its result to>
                — for impl agents: SLICE_DIR/IMPL-<role>.md (return summary)
                — for reviewers: SLICE_DIR/REVIEWS/<m>/<reviewer>.md
PRIOR_FINDINGS: <absolute paths to prior iteration's failing reviewer outputs, if any — empty for iteration 1>
```

### Capturing `SLICE_BASE`

**Always pass a SHA, not a branch name.** Branch tips move (a second-component sequential impl moves `SLICE_BRANCH`'s tip; the SHA you captured for the first agent stays valid for the slice's diff scope).

Compute once per slice, before any spawn for that slice:

```
SLICE_BASE := $(git rev-parse <parent-branch>)
# e.g. for slice 1:    git rev-parse master
# e.g. for slice 2:    git rev-parse flow/<slug>/slice-1
# e.g. for retry iter: git rev-parse <parent-branch>   # NOT the failed iter's tip — see ARTIFACTS.md
```

Record the SHA in `STATE.md` alongside the `slice-<n>-decomposed` event. Use the same SHA for every subagent spawned for that slice (impl, reviewers, retries). If the slice's parent moves between phases for any reason, **the SHA does not** — that's the point.

The orchestrator computes the envelope once per spawn and pastes it at the top of the prompt before the SOP body. Subagents reference fields by name (`SLICE_BASE`, `OUTPUT_PATH`, etc.) rather than re-deriving from git state.

For the first iteration of a slice, `PRIOR_FINDINGS` is empty. For retries, it lists the failing reviewer files from the previous iteration so the impl agent gets the failure context inline.

## Per-slice phases

### Slice phase 0: base

The slice's branch will be created off the previous slice's branch (or off `master` for slice-1). Compute it.

### Slice phase 1: decompose

Run [DECOMPOSE.md](DECOMPOSE.md) for *this slice only*. Output: `slices/<n>/DECOMPOSE.md` containing:
- Which component(s) own this slice
- File-allocation map for owned files
- Contract delta status (yes/no, what)
- The slice's test (copied from the plan, the canonical RED test for this slice)

Append `slice-<n>-decomposed` to `STATE.md`.

### Slice phase 2: contract (conditional)

Skip if the slice's contract delta is "no change."

Otherwise: spawn one Agent with [CONTRACT.md](CONTRACT.md), `isolation: "worktree"`, branch = `flow/<slug>/slice-<n>/contract` off the slice's base. When it returns, merge into a fresh `flow/<slug>/slice-<n>` branch off the slice's base.

### Slice phase 3: impl

**Slice parallelism rule: serial per slice.** Most slices touch one component. Some touch two; in that rare case, run the second component agent **after** the first lands (sequentially), not in parallel. The serial path keeps each slice's RED→GREEN cycle clean and inspectable.

Pick the SOP for the slice's component:
- Core → [IMPL-CORE.md](IMPL-CORE.md)
- Worker → [IMPL-WORKER.md](IMPL-WORKER.md)
- UI → [IMPL-UI.md](IMPL-UI.md)
- Harness → [IMPL-HARNESS.md](IMPL-HARNESS.md)

Spawn one Agent with `isolation: "worktree"`. Construct the prompt envelope per "Subagent prompt envelope" above. `SLICE_BASE` = parent slice's tip (or `master` for slice-1, or the contract merge SHA if phase 2 ran). The agent's worktree is branched off `SLICE_BASE` onto `SLICE_BRANCH`. The agent runs the slice's RED→GREEN cycle.

Wait for it. If a second component is needed:
1. **Order:** read the slice's `Order:` line from `FEATURE-PLAN.md` (and mirrored in `DECOMPOSE.md`). The producer goes first. If the slice doesn't declare an order and has two components, that's a plan error — write `BLOCKED.md` and stop. Don't guess.
2. Merge the first agent's branch into `SLICE_BRANCH` (fast-forward in the orchestrator's main checkout).
3. Spawn the second agent with a new envelope: same `SLICE_BASE` (still the parent slice's tip), but its worktree branches off the now-updated `SLICE_BRANCH` so it sees the first agent's commits.

Append `slice-<n>-impl-done` to `STATE.md`.

### Slice phase 4: review

Spawn four Agents in a single message, each with `isolation: "worktree"` checking out `SLICE_BRANCH`. Each gets the prompt envelope (with its specific `ROLE` and `OUTPUT_PATH`).

- [REVIEW-CORRECTNESS.md](REVIEW-CORRECTNESS.md)
- [REVIEW-INTEGRATION.md](REVIEW-INTEGRATION.md)
- [REVIEW-TESTS.md](REVIEW-TESTS.md) — also confirms RED→GREEN commit pattern in the slice's git log
- [REVIEW-ADR.md](REVIEW-ADR.md)

Reviewer scope is **the slice**, not the whole flow. Each reviewer uses `SLICE_BASE` from the envelope to compute the slice diff: `git diff <SLICE_BASE>..HEAD` and `git log <SLICE_BASE>..HEAD`.

### Slice phase 5: verify

On `flow/<slug>/slice-<n>`, run gates:
- `pnpm install --frozen-lockfile` if `pnpm-lock.yaml` changed
- `pnpm check` (workspace typecheck + Rust check)
- `pnpm -C apps/web build` if UI changed
- **Run every command from `slices/<n>/DECOMPOSE.md`'s "Test commands" section.** This is authoritative — don't guess script names. If the slice's RED test runs via `pnpm -C tests/e2e test:e2e`, that's what runs here.
- Cross-check: for each Rust crate the slice touches, if `<crate>/tests/` has `*.rs` files OR `<crate>/src/` contains `#[test]`/`#[cfg(test)]` and the DECOMPOSE.md "Test commands" section did **not** include a `cargo test` for that crate, that's a decompose error — write `BLOCKED.md` rather than running it implicitly. The decomposer should have enumerated it.

Write `slices/<n>/VERIFY/<iteration>.md`. Deterministic gates are authoritative; reviewer `fail` is also blocking; reviewer `pass` is advisory.

### Slice phase 6: gate

Three outcomes:

- **Hard fail.** Any deterministic gate failed OR any reviewer returned `fail`. Identify failing component, respawn its impl agent on a fresh `flow/<slug>/slice-<n>-iter<m>` branch off the slice's base, with the failure findings inline in `PRIOR_FINDINGS`. Re-run review and verify. Cap: 3 iterations. Iteration cap hit → write `BLOCKED.md` with the slice number and unresolved findings. Stop the whole flow. Earlier passing slices remain in their branches for human inspection.

- **Polish.** All gates green AND no reviewer `fail`, but reviewers returned `advisory` findings. **Triage them** — every advisory finding must be resolved one way or the other before the slice advances:
  - **Reasonable to address now** = all of: (a) the fix touches files already inside the slice's "Owned files" list in `DECOMPOSE.md`; (b) it's a small, focused change that doesn't expand slice scope or alter the slice's behavior contract; (c) addressing it doesn't depend on later slices.
  - **Not reasonable** = anything else: cross-slice concerns, feature-level redesigns, ADR-level questions, or out-of-scope cleanup. These get deferred — the orchestrator records them and moves on.
  - For each finding, write one line in `slices/<n>/ADVISORY-TRIAGE.md`: finding source (reviewer + heading), verdict (`address` | `defer`), and a one-line reason for deferrals.
  - If any advisories are marked `address`: respawn the slice's impl agent on `flow/<slug>/slice-<n>-iter<m>` (off the slice's base, like a hard-fail iteration) with `PRIOR_FINDINGS` listing the `address`-verdict findings. Re-run review and verify. Counts toward the 3-iteration cap.
  - If all advisories are `defer` (or there are none): the slice passes — append `slice-<n>-passed` to `STATE.md`, move to slice-(n+1). Deferred advisories are surfaced in the final report and `SUMMARY.md`.

- **Pass.** All gates green, no reviewer `fail`, no `advisory` findings (or all advisories triaged + addressed in a polish iteration). Append `slice-<n>-passed` to `STATE.md`. Move to slice-(n+1).

The triage rule applies on every iteration that produces advisory findings, not just the first. The 3-iteration cap covers hard-fail iterations and polish iterations together — a slice that needs three rounds of polish is a planning miss; surface it.

## Done

When slice-N passes verify, the per-slice loop is finished — but the feature is **not** declared shipped yet. Run the **Final review phase** below before writing `REPORT.md`.

## Final review phase

After slice-N's gate passes, before any landing/Graphite step. The per-slice gates only assert what each slice promised; they do not assert the feature is coherent end-to-end or that unrelated tests still pass. This phase does both.

The phase runs on the stack tip (`flow/<slug>/slice-N`). Capture two SHAs once on entry, before any subagent spawn:

```
FEATURE_BASE   := the master SHA recorded in STATE.md at flow start
FEATURE_BRANCH := flow/<slug>/slice-N
FEATURE_TIP    := $(git rev-parse FEATURE_BRANCH)   # snapshot the tip
```

The diff scope for this phase is `git diff <FEATURE_BASE>..<FEATURE_TIP>` — the union of every slice.

### Final phase 1: feature-level deterministic gates

On `FEATURE_BRANCH`, run every gate, top to bottom, capturing pass/fail per command:

- `pnpm install --frozen-lockfile` if `pnpm-lock.yaml` changed across the feature
- `pnpm check` (workspace typecheck + Rust check)
- `pnpm -C apps/web build` if the feature touched `apps/web/**` or `packages/ui-sdk/**`
- `cargo test --workspace` (every Rust crate, not just the slices' touched crates — this catches regressions)
- `pnpm exec playwright install chromium` (idempotent — no-op if cached)
- `pnpm -C tests/e2e test:e2e` — **the entire e2e suite**, including any new specs the feature added. This is the bar the user expects: all e2e tests green, including the newly-added ones for this feature.
- Any other repo-level test commands enumerated across the slices' `DECOMPOSE.md` "Test commands" sections; deduplicate and run each once.

Write `FINAL-VERIFY/<iteration>.md` with the command/status table.

### Final phase 2: feature-level reviewers

Spawn the four reviewers in parallel, each with `isolation: "worktree"` checking out `FEATURE_BRANCH`. The envelope mirrors slice review except:

```
SLICE:        feature
SLICE_BASE:   <FEATURE_BASE>
SLICE_BRANCH: <FEATURE_BRANCH>
OUTPUT_PATH:  <RUN_DIR>/FINAL-REVIEWS/<iteration>/<reviewer>.md
PRIOR_FINDINGS: <RUN_DIR>/FINAL-REVIEWS/<iteration-1>/<reviewer>.md  (only on retry)
```

Reviewers use the existing SOPs ([REVIEW-CORRECTNESS.md](REVIEW-CORRECTNESS.md), [REVIEW-INTEGRATION.md](REVIEW-INTEGRATION.md), [REVIEW-TESTS.md](REVIEW-TESTS.md), [REVIEW-ADR.md](REVIEW-ADR.md)) — they're already diff-scoped, so feeding the feature diff makes them feature-scoped. They catch what per-slice review can't: cross-slice integration drift, contract divergence between producer and consumer slices, ADR contradictions that only emerge from the full diff, missing tests for behavior introduced piecewise.

Note for reviewers: when `SLICE: feature`, the tests reviewer's TDD-commit-pattern check is **scoped per slice**, not over the whole feature diff. Each slice already had its own pattern review in phase 4; the feature-level tests reviewer asserts gates and union test coverage, not the merged commit log.

### Final phase 3: gate

Same three outcomes as a slice gate, applied at feature scope:

- **Hard fail.** Any feature-level gate failed OR any reviewer returned `fail`. Diagnose which slice (or cross-slice seam) introduced the problem, then respawn its impl agent on `flow/<slug>/slice-N` directly (the stack tip) with `PRIOR_FINDINGS` listing the failures. The fix lands on top of slice-N as a new commit pair (`test(<comp>): final fix — <brief>` then `<comp>: final fix — <brief>`). Re-run final phases 1–3. Cap: 3 final iterations. Iteration cap hit → write `BLOCKED.md` and stop.

- **Polish.** All gates green, no reviewer `fail`, but advisory findings exist. Triage with the same "reasonable to address now" rule as a slice gate, scoped to the feature. Reasonable feature-level fixes land on `flow/<slug>/slice-N` as a final polish commit pair. Deferred findings go into `RUN_DIR/FINAL-ADVISORY-DEFERRED.md`. After fixes, re-run final phases 1–3. Counts toward the 3 final-iteration cap.

- **Pass.** All gates green, no reviewer `fail`, no remaining advisories (or all triaged + handled). Append `final-review-passed` to `STATE.md`. Proceed to the landing step.

Final-iteration commits land on `flow/<slug>/slice-N` directly — they don't introduce a new branch. The Graphite stack stays at N branches.

### Landing the stack with Graphite

Each slice is a branch off the previous one — exactly the shape Graphite (`gt`) expects. Use it to publish stacked PRs.

From the repo root, on `flow/<slug>/slice-N` (the tip):

```
gt track                # adopt the existing branches into Graphite's stack tracking
gt log                  # confirm the stack is visible bottom→top: master → slice-1 → ... → slice-N
gt submit --stack       # create one PR per slice; each PR's base is the slice below it
```

Notes:
- `gt track` is idempotent — safe to run on a stack Graphite already knows.
- `gt submit --stack` pushes every branch in the stack and opens PRs on the remote. PRs land bottom-up (slice-1 first); subsequent merges automatically rebase the rest.
- If you'd rather land as a single PR, skip `gt` and merge `flow/<slug>/slice-N` directly. The stacked path is the recommended one because each slice was designed to be reviewable independently.

Include the three commands above in `REPORT.md` so the user has a copy-pasteable handoff.

Then write `REPORT.md` listing each slice, its branch, its commits, and the final review's outcome. Then run the **Summary phase** — see below.

## Summary phase (terminal)

Runs after `REPORT.md` (success) or `BLOCKED.md` (failure). Always runs. Output: `SUMMARY.md` — a short, mechanical digest of what happened. Used for after-the-fact reference; the user catches mistakes in real time, not from this file.

### Steps

1. Walk `STATE.md`. Per slice: iteration count, outcome (`passed` / `blocked`).
2. List every reviewer `fail` verdict (slice or `final`, iteration, reviewer, one-line finding).
3. Aggregate deferred advisory findings: read every `slices/<n>/ADVISORY-TRIAGE.md` (deferred entries only) and `FINAL-ADVISORY-DEFERRED.md` if present.
4. Record final-review outcome: number of final iterations, gate results, advisories addressed vs deferred.
5. List every `BLOCKED.md` content verbatim.
6. Append `summary-written` to `STATE.md`. This is the final event.

### SUMMARY.md template

```md
# Summary: <slug>

Outcome: success | blocked

## Slices

| Slice | Title | Iterations | Outcome |
|---|---|---|---|
| 1 | ... | 1 | passed |
| 2 | ... | 2 | passed |
| 3 | ... | 3 | blocked |

## Final review

- Iterations: <n>
- Gate: pass | fail (one-line summary)
- Advisories addressed: <count>
- Advisories deferred: <count>

## Reviewer fails

(One line per `fail` verdict across slice and final review. Empty if none.)

- slice-<n> iter-<m> review-<role>: <verbatim one-line finding>
- final iter-<m> review-<role>: <verbatim one-line finding>

## Deferred advisories

(Triaged-but-not-addressed findings, slice and final. Empty if none.)

- slice-<n> review-<role>: <one-line finding> — <one-line reason for deferral>
- final review-<role>: <one-line finding> — <one-line reason for deferral>

## Hard blocks

(Verbatim content of any BLOCKED.md. Empty if none.)
```

That's it. No interpretation, no "patterns" section, no friction-signal aggregation. The user reads the run as it happens and corrects directly; the summary is just a record.

## Rules

- **Plan is law.** If you find ambiguity, write to `OPEN-QUESTIONS.md` and continue with the most defensible interpretation. Do not ask the user mid-flow.
- **One slice at a time.** Never parallelize across slices. The whole point of stacking is that slice-(n+1) sees slice-n's result.
- **Serial within slice.** One impl agent at a time, even if multiple components are involved.
- **Slice tests must run end-to-end.** A slice that "passes" only because its test was elided is a regression. Reviewers enforce this.
- **Component agents only edit their files** (per `DECOMPOSE.md`).
- **Never commit to `master`.** All work lives on `flow/<slug>/slice-<n>` branches.
- **Don't invoke `/feature-flow` recursively.** Sub-task replan = `BLOCKED.md`.

## When to stop early

- `FEATURE-PLAN.md` missing or has no `## Slices` section → stop, ask user to plan.
- Decompose detects unresolvable file overlap **between this slice and an earlier-merged slice** → stop, the plan has bad slice ordering.
- Iteration cap hit on any slice → write `BLOCKED.md`, surface to user.
- Verify fails with the same error two iterations in a row on the same slice → stop, the loop is not converging.
- Final review iteration cap hit → write `BLOCKED.md`, surface to user. The stack is intact for human inspection; the unresolved findings are in `RUN_DIR/FINAL-REVIEWS/<last-iter>/`.
