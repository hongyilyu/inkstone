---
name: feature-flow
description: >-
  End-to-end feature delivery for inkstone. Pass anything — a vague request, a
  half-formed plan, or an existing FEATURE-PLAN.md path. The skill grills the
  user as needed to produce a runnable plan, then autonomously executes it as a
  sequence of vertical slices (per slice: decompose, optional contract, impl,
  review, verify, squash). Use when the user wants to build, design, or deliver
  a feature.
---

# /feature-flow

Two phases. **Intake** (interactive — turns whatever the user provided into a runnable `FEATURE-PLAN.md`) and **slice loop** (autonomous — runs each slice and squashes it into one commit on a single feature branch, no user input until done or blocked).

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

You are *deciding*, not implementing. The hardest decision is **slicing** — splitting the feature into a sequence of small, vertical, end-to-end-testable increments.

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
   - **Sequential**: each slice builds on the previous one's committed result — it becomes the next commit on the feature branch.

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
└── feature/<slug>     ← durable; one squashed commit per slice (slice-1 … slice-N)
```

Each slice is developed on a scratch branch `flow/<slug>/slice-<n>` cut from `feature/<slug>`'s tip, then squashed into a single commit on `feature/<slug>` once it passes its gate. See [ARTIFACTS.md](ARTIFACTS.md) for the branch model in full.

`feature/<slug>` opens a single PR for review only after the final review passes — and the user owns the merge to `master`, not you.

For each slice, in order:

```
0. base       → cut scratch branch flow/<slug>/slice-<n> from feature/<slug>'s tip
1. decompose  → confirm component(s), files, contract delta for this slice
2. contract   → if needed; sequential, blocks impl
3. impl       → 1 (usually) or 2 (rarely) impl agents — see "Slice parallelism" below
4. review     → 4 reviewers in parallel, each in own worktree
5. verify     → run gates on the slice's scratch branch
6. gate       → all green + advisories triaged? squash the slice into one commit on
                feature/<slug>, then proceed to slice-(n+1).
                Any fail or unhandled-reasonable-advisory? loop slice (cap 3).
```

After slice-N's gate passes, the **Final review phase** runs once over the whole `feature/<slug>` branch: feature-level gates (the full four-job CI mirror, run locally), feature-level reviewers, and a **deep-review pass** (the [deep-review](../deep-review/SKILL.md) skill). Every review finding must be addressed-or-reasoned; then the branch is **rebased onto the latest `master` and the local CI gate re-run on the rebased tree** before the PR is pushed, so it clears CI before opening. The PR is opened, **CI must go green**, and only then is `REPORT.md` written and the feature declared done.

Slice failures don't block other slices from being attempted **only if** the failure is contained — which it almost never is, since each slice builds on the previous one's commit. In practice: a slice that fails its retry cap halts the whole flow.

## Phase 0: setup (once per flow)

Intake already validated the plan and received user sign-off. This phase is mechanical setup:

1. Verify working tree clean: `git status --porcelain`. If not, stop — don't risk WIP.
2. Confirm `master` is the base branch.
3. The run directory `.agents/runs/<slug>/` already exists (intake created it). Init `STATE.md`.
4. Capture the flow's base SHA: `FEATURE_BASE := $(git rev-parse master)`. Record it in `STATE.md` alongside the `started` event — the Final review phase reads it from there.
5. Create the durable feature branch off master: `git branch feature/<slug> master`. Every passing slice lands here as one squashed commit, and the final PR is opened from it. Don't check it out — the orchestrator stays on `master` and builds slices in worktrees.
6. Append `started` to `STATE.md`.

## Subagent prompt envelope

Every subagent (impl or reviewer) you spawn must receive a structured prompt block at the top with these fields. The SOPs assume these are present.

```
SLUG:           <slug>
SLICE:          <n>
ITERATION:      <m>
ROLE:           <core|worker|ui|harness|contract|review-correctness|review-integration|review-tests|review-adr>
RUN_DIR:        <absolute path to .agents/runs/<slug>/>
SLICE_DIR:      <absolute path to .agents/runs/<slug>/slices/<n>/>
PARENT_SHA:     <SHA of feature/<slug>'s tip — the previous slice's squashed commit; FEATURE_BASE (master) for slice-1>
SLICE_BASE:     <PARENT_SHA — the SHA the diff is computed against; use this for `git diff <SLICE_BASE>..HEAD` and `git log <SLICE_BASE>..HEAD`>
SLICE_BRANCH:   flow/<slug>/slice-<n>[-iter<m>]    (the scratch branch the agent is on)
OUTPUT_PATH:    <absolute path the agent writes its result to>
                — for impl agents: SLICE_DIR/IMPL-<role>.md (return summary)
                — for reviewers: SLICE_DIR/REVIEWS/<m>/<reviewer>.md
PRIOR_FINDINGS: <absolute paths to prior iteration's failing reviewer outputs, if any — empty for iteration 1>
```

### Capturing `SLICE_BASE`

**Always pass a SHA, not a branch name.** Branch tips move (a second-component sequential impl moves `SLICE_BRANCH`'s tip; the SHA you captured for the first agent stays valid for the slice's diff scope).

Compute once per slice, before any spawn for that slice:

```
SLICE_BASE := $(git rev-parse feature/<slug>)   # the durable branch tip
# e.g. for slice 1:    feature/<slug> == master (freshly cut), so this is FEATURE_BASE
# e.g. for slice 2:    feature/<slug>'s tip is slice-1's squashed commit
# e.g. for retry iter: still git rev-parse feature/<slug>   # NOT the failed iter's tip — see ARTIFACTS.md
```

Record the SHA in `STATE.md` alongside the `slice-<n>-decomposed` event. Use the same SHA for every subagent spawned for that slice (impl, reviewers, retries). If the slice's parent moves between phases for any reason, **the SHA does not** — that's the point.

The orchestrator computes the envelope once per spawn and pastes it at the top of the prompt before the SOP body. Subagents reference fields by name (`SLICE_BASE`, `OUTPUT_PATH`, etc.) rather than re-deriving from git state.

For the first iteration of a slice, `PRIOR_FINDINGS` is empty. For retries, it lists the failing reviewer files from the previous iteration so the impl agent gets the failure context inline.

## Per-slice phases

### Slice phase 0: base

The slice's scratch branch `flow/<slug>/slice-<n>` is cut from `feature/<slug>`'s tip — which is slice-(n-1)'s squashed commit, or `master`/`FEATURE_BASE` for slice-1. Capture `SLICE_BASE := $(git rev-parse feature/<slug>)`.

### Slice phase 1: decompose

Run [DECOMPOSE.md](DECOMPOSE.md) for *this slice only*. Output: `slices/<n>/DECOMPOSE.md` containing:
- Which component(s) own this slice
- File-allocation map for owned files
- Contract delta status (yes/no, what)
- The slice's test (copied from the plan, the canonical RED test for this slice)

Append `slice-<n>-decomposed` to `STATE.md`.

### Slice phase 2: contract (conditional)

Skip if the slice's contract delta is "no change."

Otherwise: spawn one Agent with [CONTRACT.md](CONTRACT.md), `isolation: "worktree"`, branch = `flow/<slug>/slice-<n>-contract` off the slice's base (`feature/<slug>`'s tip). When it returns, create the slice's scratch branch `flow/<slug>/slice-<n>` off the same base and merge the contract branch into it — that merge commit is the contract merge SHA used as `SLICE_BASE` in phase 3.

Use the `-contract` suffix, not a `/contract` child: a `flow/<slug>/slice-<n>/contract` ref collides with the `flow/<slug>/slice-<n>` branch — git can't have a ref be both a file and a directory.

### Slice phase 3: impl

**Slice parallelism rule: serial per slice.** Most slices touch one component. Some touch two; in that rare case, run the second component agent **after** the first lands (sequentially), not in parallel. The serial path keeps each slice's RED→GREEN cycle clean and inspectable.

Pick the SOP for the slice's component:
- Core → [IMPL-CORE.md](IMPL-CORE.md)
- Worker → [IMPL-WORKER.md](IMPL-WORKER.md)
- UI → [IMPL-UI.md](IMPL-UI.md)
- Harness → [IMPL-HARNESS.md](IMPL-HARNESS.md)

Spawn one Agent with `isolation: "worktree"`. Construct the prompt envelope per "Subagent prompt envelope" above. `SLICE_BASE` = `feature/<slug>`'s tip (or the contract merge SHA if phase 2 ran). The agent's worktree is branched off `SLICE_BASE` onto `SLICE_BRANCH`. The agent runs the slice's RED→GREEN cycle.

Wait for it. If a second component is needed:
1. **Order:** read the slice's `Order:` line from `FEATURE-PLAN.md` (and mirrored in `DECOMPOSE.md`). The producer goes first. If the slice doesn't declare an order and has two components, that's a plan error — write `BLOCKED.md` and stop. Don't guess.
2. Merge the first agent's branch into `SLICE_BRANCH` (fast-forward in the orchestrator's main checkout).
3. Spawn the second agent with a new envelope: same `SLICE_BASE` (still `feature/<slug>`'s tip), but its worktree branches off the now-updated `SLICE_BRANCH` so it sees the first agent's commits.

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

- **Hard fail.** Any deterministic gate failed OR any reviewer returned `fail`. Identify failing component, respawn its impl agent on a fresh `flow/<slug>/slice-<n>-iter<m>` branch off the slice's base, with the failure findings inline in `PRIOR_FINDINGS`. Re-run review and verify. Cap: 3 iterations. Iteration cap hit → write `BLOCKED.md` with the slice number and unresolved findings. Stop the whole flow. Earlier passing slices remain as commits on `feature/<slug>` for human inspection.

- **Polish.** All gates green AND no reviewer `fail`, but reviewers returned `advisory` findings. **Triage them** — every advisory finding must be resolved one way or the other before the slice advances:
  - **Reasonable to address now** = all of: (a) the fix touches files already inside the slice's "Owned files" list in `DECOMPOSE.md`; (b) it's a small, focused change that doesn't expand slice scope or alter the slice's behavior contract; (c) addressing it doesn't depend on later slices.
  - **Not reasonable** = anything else: cross-slice concerns, feature-level redesigns, ADR-level questions, or out-of-scope cleanup. These get deferred — the orchestrator records them and moves on.
  - For each finding, write one line in `slices/<n>/ADVISORY-TRIAGE.md`: finding source (reviewer + heading), verdict (`address` | `defer`), and a one-line reason for deferrals.
  - If any advisories are marked `address`: respawn the slice's impl agent on `flow/<slug>/slice-<n>-iter<m>` (off the slice's base, like a hard-fail iteration) with `PRIOR_FINDINGS` listing the `address`-verdict findings. Re-run review and verify. Counts toward the 3-iteration cap.
  - If all advisories are `defer` (or there are none): the slice passes — follow the **Pass** outcome below (squash onto `feature/<slug>`, append `slice-<n>-passed`, advance). Deferred advisories are surfaced in the final report and `SUMMARY.md`.

- **Pass.** All gates green, no reviewer `fail`, no `advisory` findings (or all advisories triaged + addressed in a polish iteration). **Squash the slice onto the feature branch.** From the orchestrator's `master` checkout (working tree clean — impl happened in worktrees):

  ```
  git checkout feature/<slug>
  git merge --squash flow/<slug>/slice-<n>      # or the latest passing -iter<m> branch
  git commit -m "slice-<n>: <slice title>"      # one commit capturing the whole slice
  git checkout master
  ```

  The squash collapses the slice's RED→GREEN commits into a single commit; the scratch branch already passed review in phase 4, so its commit-level TDD pattern is on record. Append `slice-<n>-passed` to `STATE.md` (detail: the squashed commit SHA). Move to slice-(n+1) — its base is the new `feature/<slug>` tip.

The triage rule applies on every iteration that produces advisory findings, not just the first. The 3-iteration cap covers hard-fail iterations and polish iterations together — a slice that needs three rounds of polish is a planning miss; surface it.

## Done

When slice-N passes verify, the per-slice loop is finished — but the feature is **not** declared shipped yet. Run the **Final review phase** below — feature-level gates, structured reviewers, deep-review, and a green CI run — before writing `REPORT.md`.

## Final review phase

After slice-N's gate passes, before the landing step. The per-slice gates only assert what each slice promised; they do not assert the feature is coherent end-to-end or that unrelated tests still pass. This phase does both.

The phase runs on `feature/<slug>` — which now holds one squashed commit per slice. Capture two SHAs once on entry, before any subagent spawn:

```
FEATURE_BASE   := the master SHA recorded in STATE.md at flow start
FEATURE_BRANCH := feature/<slug>
FEATURE_TIP    := $(git rev-parse FEATURE_BRANCH)   # snapshot the tip
```

The diff scope for this phase is `git diff <FEATURE_BASE>..<FEATURE_TIP>` — the union of every slice.

### Final phase 1: feature-level deterministic gates

This is the repo's [§6 CI gate](../../../.github/workflows/ci.yml) run **locally and in full** — the same four jobs (`lint-format`, `ts`, `rust`, `e2e`) the PR will face on a clean runner, in the same commands. Running it here, and again on the rebased tree before push (landing step 2), is how the feature clears CI *before* the PR opens rather than after. On `FEATURE_BRANCH`, run every gate top to bottom, capturing pass/fail per command:

- `pnpm install --frozen-lockfile` if `pnpm-lock.yaml` changed across the feature — CI runs a frozen install before every job; a drifted lockfile fails there.
- **`lint-format`** — `pnpm exec biome ci .` (format + lint + organizeImports, read-only — the exact CI command; `pnpm format` writes and `pnpm lint` only covers lint, so neither is the gate).
- **`ts`** — `pnpm -r --if-present check` (tsc across the workspace; this is `pnpm check`'s TS half) **then** `pnpm -r test` (vitest in every package, including `tests/contract`'s schema-parity suite). The workspace vitest run is a required CI check — do not skip it.
- **`rust`** — `cargo check --locked --manifest-path crates/core/Cargo.toml`, then `cargo test --locked --manifest-path crates/core/Cargo.toml`, then the schema-fixture staleness gate: `cargo test --locked --manifest-path crates/core/Cargo.toml regenerate_schema_fixtures` followed by `git add -N tests/contract/fixtures/ && git diff --exit-code tests/contract/fixtures/` (red if a `PayloadSpec` change wasn't re-committed). `crates/core` is the only crate, so this is the whole Rust gate.
- **`e2e`** — `pnpm -C apps/web build` first if the feature touched `apps/web/**` or `packages/ui-sdk/**` (a fast pre-signal; e2e's globalSetup rebuilds it anyway), then `pnpm -C tests/e2e exec playwright install chromium` (idempotent — no-op if cached; the `-C tests/e2e` is load-bearing — Playwright is an `@inkstone/e2e` devDep, so a root `pnpm exec` can't resolve the binary), then `pnpm test:e2e` — **the entire e2e suite**, including any new specs the feature added. This is the bar the user expects: all e2e green, including the newly-added ones for this feature.
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

Note for reviewers: when `SLICE: feature`, `feature/<slug>` carries one squashed commit per slice, so the RED→GREEN commit pattern is **not** visible here — it was already verified per slice in phase 4 on each scratch branch. The feature-level tests reviewer **skips** the commit-pattern check and asserts gates and union test coverage only.

### Final phase 2b: deep-review pass

After the four structured reviewers return, run the [deep-review](../deep-review/SKILL.md) skill in **RUN mode**, scoped to the whole feature diff (`git diff <FEATURE_BASE>..<FEATURE_TIP>`). It is a multi-agent fan-out (specialist lenses + adversarial verification + the learned rule base) that catches classes of bug the four structured reviewers don't — it complements them, it doesn't replace them.

Invoke it from a worktree on `FEATURE_BRANCH`. Write its verified report to `<RUN_DIR>/FINAL-REVIEWS/<iteration>/deep-review.md`. deep-review already drops refuted findings in its own verification pass, so what lands in that file is the surviving, verified set.

Fold the surviving findings into the Final phase 3 gate exactly like reviewer findings: **Blocking / Important** deep-review findings are blocking (treat like a reviewer `fail`); **Nit** findings are advisory. They are subject to the same address-or-reason rule below — no deep-review finding is silently dropped.

Append `deep-review-done` to `STATE.md` (detail: counts by severity, and how many deep-review dropped in verification).

### Final phase 3: gate

Same three outcomes as a slice gate, applied at feature scope. The finding pool here is the union of the four structured reviewers **and** the deep-review pass (phase 2b).

**Address-or-reason is mandatory.** No finding — from a structured reviewer or from deep-review — may advance past this gate unresolved. Each is either *addressed* (fixed in a `final-fix:` commit) or *reasoned* (recorded with a one-line justification for not acting now). "Reasoned" means a deliberate, written verdict, not silence. The same rule applies on every final iteration, not just the first.

- **Hard fail.** Any feature-level gate failed OR any reviewer returned `fail` OR deep-review returned a Blocking/Important finding. Diagnose which slice (or cross-slice seam) introduced the problem, then respawn its impl agent on a scratch branch `flow/<slug>/final-iter<m>` cut from `feature/<slug>`'s tip, with `PRIOR_FINDINGS` listing the failures. It runs RED→GREEN there; when green, squash it into one commit on `feature/<slug>` (`git merge --squash` + `git commit -m "final-fix: <brief>"`). Re-run final phases 1–3. Cap: 3 final iterations. Iteration cap hit → write `BLOCKED.md` and stop.

- **Polish.** All gates green, no reviewer `fail`, no Blocking/Important deep-review finding, but advisory findings exist (reviewer advisories and/or deep-review Nits). Triage **every** advisory with the "reasonable to address now" rule as a slice gate, scoped to the feature — each gets an `address` or `defer` verdict with a one-line reason. Reasonable feature-level fixes are developed on `flow/<slug>/final-iter<m>` and squashed into one `final-fix:` commit on `feature/<slug>`, same as a hard-fail iteration. Deferred findings (with their reasons) go into `RUN_DIR/FINAL-ADVISORY-DEFERRED.md`. After fixes, re-run final phases 1–3. Counts toward the 3 final-iteration cap.

- **Pass.** All gates green, no reviewer `fail`, no Blocking/Important deep-review finding, and **every** remaining finding (reviewer or deep-review) has been triaged — addressed or deferred-with-a-reason. Nothing is left un-adjudicated. Append `final-review-passed` to `STATE.md`. Proceed to the landing step.

Final-iteration fixes are squashed onto `feature/<slug>` as `final-fix:` commits, so the branch stays clean: N slice commits plus any final-fix commits.

### Landing the feature: one PR

`feature/<slug>` holds the whole feature — one commit per slice (plus any `final-fix:` commits), all green against the `master` the flow started from (`FEATURE_BASE`). But `master` has likely advanced since then. Rebase onto its current tip and re-clear the gate **before** pushing — never push a branch whose base is stale or whose local CI hasn't passed on the exact tree being pushed.

Land it as a **single PR**. No Graphite, no stacked PRs.

**Step 1 — rebase onto the latest `master`.** From the orchestrator's `master` checkout (working tree clean):

```
git fetch origin master
git checkout feature/<slug>
git rebase origin/master
```

- **Clean rebase** → the one-commit-per-slice (+`final-fix:`) history is now replayed on the current `master`. Append `rebased` to `STATE.md` (detail: the `origin/master` SHA). Continue to step 2.
- **Conflicts** → resolve them in line with the slice that owns each hunk; `git rebase --continue` until clean. A conflict that can't be resolved without re-opening a design decision is a hard fail — append `rebase-conflict` (detail: the conflicting paths), write `BLOCKED.md`, and stop. Don't `-X ours`/`-X theirs` your way past a semantic clash.

**Step 2 — re-run the full local CI gate on the rebased tip.** A clean rebase is not a green one: the new `master` can carry changes that break the feature (or vice-versa) with zero textual conflict. Re-run **Final phase 1** (the four-job CI mirror, in full) against the rebased `feature/<slug>`. Any failure → treat exactly as a Final phase 3 hard fail (fix on `flow/<slug>/final-iter<m>`, squash a `final-fix:` commit, counts toward the 3-iteration cap), then rebase-check again. Push only once the gate is green on the rebased tree; append `local-ci-passed` to `STATE.md` (detail: the rebased commit SHA).

**Step 3 — push and open the PR.** From the repo root:

```
git push -u origin feature/<slug>
gh pr create --base master --head feature/<slug> \
  --title "<feature title>" \
  --body "<one-paragraph goal + slice-by-slice commit list>"
```

Notes:
- One PR, reviewed as a unit. The one-commit-per-slice history lets a reviewer walk the feature slice by slice.
- The rebase is **non-destructive to `master`** — it only replays `feature/<slug>`'s own commits onto the fetched `origin/master`. It does not touch, fast-forward, or push `master`.
- Pushing the feature branch and opening the PR is allowed; **merging to `master` is not** — the user owns the merge.
- If the remote or `gh` isn't available, the rebase can't fetch and the push can't run: skip steps 1 and 3, record in `REPORT.md` that the gate passed locally on the **pre-rebase** tip (CI and rebase unverified), and write the three commands above as a copy-pasteable handoff. The user rebases, re-gates, and pushes.

Record the PR URL (or the handoff commands) in `REPORT.md`.

### Wait for CI to go green

Opening the PR is not the finish line — **the feature is not done until CI passes.** The repo's GitHub Actions [§6 gate](../../../.github/workflows/ci.yml) runs four required checks on the PR (`lint-format`, `ts`, `rust`, `e2e`). The local final-phase gates mirror these, but CI runs them on a clean runner and can surface failures a local run masked (lockfile drift, OS-dep gaps, environment assumptions).

After opening the PR, poll until the checks settle:

```
gh pr checks <pr-number> --watch
```

- **All checks pass** → append `ci-passed` to `STATE.md` (detail: the commit SHA CI ran on). Proceed to write `REPORT.md`.
- **Any check fails** → this is a hard fail, identical to a Final phase 3 hard fail. Pull the failing job's logs (`gh run view <run-id> --log-failed`), diagnose, fix on a `flow/<slug>/final-iter<m>` branch, squash a `final-fix:` commit onto `feature/<slug>`, push, and re-poll. Counts toward the 3 final-iteration cap. Cap hit with CI still red → write `BLOCKED.md` and stop; the feature is **not** done.
- **`gh` / remote unavailable** (handoff mode, no PR opened) → CI can't be polled. Record in `REPORT.md` that the §6 gate passed locally but CI was not verified, and that the user must confirm CI green before merging.

Only once CI is green (or explicitly unverifiable in handoff mode) is the feature done.

Then write `REPORT.md` listing each slice, its squashed commit on `feature/<slug>`, the final review's outcome (structured reviewers + deep-review), the CI status, and the PR URL (or handoff commands). Then run the **Summary phase** — see below.

## Summary phase (terminal)

Runs after `REPORT.md` (success) or `BLOCKED.md` (failure). Always runs. Output: `SUMMARY.md` — a short, mechanical digest of what happened. Used for after-the-fact reference; the user catches mistakes in real time, not from this file.

### Steps

1. Walk `STATE.md`. Per slice: iteration count, outcome (`passed` / `blocked`).
2. List every reviewer `fail` verdict (slice or `final`, iteration, reviewer, one-line finding). Include deep-review Blocking/Important findings (read `FINAL-REVIEWS/<iter>/deep-review.md`).
3. Aggregate deferred advisory findings: read every `slices/<n>/ADVISORY-TRIAGE.md` (deferred entries only) and `FINAL-ADVISORY-DEFERRED.md` if present.
4. Record final-review outcome: number of final iterations, gate results, deep-review severity counts, advisories addressed vs deferred.
5. Record the CI outcome (from the `ci-passed` / `ci-failed` event, or "unverified — handoff mode").
6. List every `BLOCKED.md` content verbatim.
7. Append `summary-written` to `STATE.md`. This is the final event.

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
- Deep-review: <blocking>/<important>/<nit> findings (<dropped> dropped in verification)
- Advisories addressed: <count>
- Advisories deferred: <count>
- CI: passed (<sha>) | failed (<check>) | unverified — handoff mode

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
- **One slice at a time.** Never parallelize across slices. The whole point is that slice-(n+1) builds on slice-n's squashed commit on `feature/<slug>`.
- **Serial within slice.** One impl agent at a time, even if multiple components are involved.
- **Slice tests must run end-to-end.** A slice that "passes" only because its test was elided is a regression. Reviewers enforce this.
- **Component agents only edit their files** (per `DECOMPOSE.md`).
- **Never commit to `master`.** Slices land on `feature/<slug>` (durable, one commit per slice); each is built on a `flow/<slug>/slice-<n>` scratch branch.
- **Don't invoke `/feature-flow` recursively.** Sub-task replan = `BLOCKED.md`.

## When to stop early

- `FEATURE-PLAN.md` missing or has no `## Slices` section → stop, ask user to plan.
- Decompose detects unresolvable file overlap **between this slice and an earlier slice already squashed onto `feature/<slug>`** → stop, the plan has bad slice ordering.
- Iteration cap hit on any slice → write `BLOCKED.md`, surface to user.
- Verify fails with the same error two iterations in a row on the same slice → stop, the loop is not converging.
- Final review iteration cap hit → write `BLOCKED.md`, surface to user. `feature/<slug>` and the scratch branches are intact for human inspection; the unresolved findings are in `RUN_DIR/FINAL-REVIEWS/<last-iter>/`.
- CI stays red after the final-iteration cap → write `BLOCKED.md`. The PR is open with a failing gate; the feature is not done until the user-owned CI checks are green.
