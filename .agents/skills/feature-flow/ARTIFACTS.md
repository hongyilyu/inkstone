# Run artifacts

All run state lives under `.agents/runs/<slug>/`. The orchestrator owns this directory; subagents are told to write specific files in it.

## Layout

```
.agents/runs/<slug>/
├── FEATURE-PLAN.md              # written by intake phase, read-only after slice loop starts
├── STATE.md                     # append-only event log (see format below)
├── slices/
│   ├── 1/
│   │   ├── DECOMPOSE.md         # written in slice phase 1
│   │   ├── CONTRACT-DELTA.md    # written in slice phase 2 (or absent)
│   │   ├── REVIEWS/
│   │   │   ├── 1/                # iteration 1
│   │   │   │   ├── correctness.md
│   │   │   │   ├── integration.md
│   │   │   │   ├── tests.md
│   │   │   │   └── adr.md
│   │   │   └── 2/                # iteration 2 (only on retry)
│   │   ├── VERIFY/
│   │   │   ├── 1.md
│   │   │   └── 2.md
│   │   ├── ADVISORY-TRIAGE.md   # per-iteration triage of advisory findings (address vs defer)
│   │   ├── OPEN-QUESTIONS.md    # ambiguities found mid-slice (optional)
│   │   └── BLOCKED.md           # only if this slice halted the flow
│   ├── 2/...
│   └── N/...
├── FINAL-VERIFY/                # written by the Final gate phase's deterministic gates (per iteration)
│   ├── 1.md
│   └── 2.md
├── REPORT.md                    # written after the Final gate phase passes + handoff to /review-loop
├── BLOCKED.md                   # written if any slice or the final gate hit its retry cap
└── SUMMARY.md                   # always written last; mechanical digest
```

Feature-scope code review (the structured reviewers + deep-review + thermo-nuclear, across both engines) is **no longer** a feature-flow artifact — it is owned by [`/review-loop`](../review-loop/SKILL.md)'s Phase 0, which runs after feature-flow hands off the rebased, gate-green branch.

Worktrees are created by the `Agent` tool's `isolation: "worktree"` mode. The harness picks the path. Record returned paths in `STATE.md`.

## STATE.md format

Append-only, newest at the bottom. One line per event. Format:

```
<ISO-8601 timestamp>  <scope>  <event>  <detail>
```

Scope is `flow` for top-level events, `slice-<n>` for slice-scoped events, or `final` for Final-gate-phase events.

Top-level events (scope `flow`):

- `started` — detail includes `feature-base=<sha>` (the master SHA captured at flow start; the Final gate phase reads it from here)
- `done` — REPORT.md written
- `blocked` — BLOCKED.md written
- `summary-written` — SUMMARY.md written; final event

Slice events (scope `slice-<n>`):

- `decomposed`
- `contract-skipped` | `contract-merged`
- `impl-spawned` (with worktree path) | `impl-done`
- `review-spawned` | `review-done`
- `verify-pass` | `verify-fail`
- `advisory-triaged` (with `addressed=<n> deferred=<n>`)
- `iter-end` (when respawning for another iteration — hard fail or polish)
- `passed` (slice green and squashed onto `feature/<slug>`; detail includes the squashed commit SHA)
- `blocked` (this slice hit retry cap)

Final-gate events (scope `final`):

- `final-gate-passed` (the full four-job CI mirror is green on the pre-rebase tip)
- `iter-end` (final-gate retry — a deterministic gate failed and a `final-fix:` commit was squashed)
- `rebased` (detail: the `origin/master` SHA rebased onto) | `rebase-conflict` (detail: conflicting paths → BLOCKED.md)
- `local-ci-passed` (detail: the rebased commit SHA the full four-job gate passed on)
- `handed-off-to-review-loop` (the rebased, gate-green branch was handed to `/review-loop`; it owns the PR + both review phases)
- `blocked` (final gate hit its retry cap, or a rebase conflict needed a design decision)

## Branch model

One durable branch, one commit per slice.

```
master
└── feature/<slug>                     ← durable; one squashed commit per slice
       slice-1   ← squashed from flow/<slug>/slice-1
       slice-2   ← squashed from flow/<slug>/slice-2
       …
       slice-N   ← squashed from flow/<slug>/slice-N
```

Each slice is built on a throwaway scratch branch cut from `feature/<slug>`'s current tip, then squashed back onto it:

```
feature/<slug> tip ──┬── flow/<slug>/slice-<n>          ← scratch; RED→GREEN commits, reviewed here
                     └── flow/<slug>/slice-<n>-iter<m>  ← retry, off the same tip
```

Per-slice details:
- The scratch branch `flow/<slug>/slice-<n>` is cut from `feature/<slug>`'s current tip (slice-(n-1)'s squashed commit, or `master` for slice-1).
- The impl agent commits RED→GREEN on the scratch branch; the tests reviewer verifies that pattern in phase 4.
- On gate pass, the orchestrator squashes the scratch branch into a single commit on `feature/<slug>` (`git merge --squash` + `git commit`). The scratch branch is kept for debugging but never built on again.
- A retry iteration creates `flow/<slug>/slice-<n>-iter<m>` off `feature/<slug>`'s tip (i.e., not off the failing iteration). Failed iterations are kept for diff/debugging.
- The contract phase, when present, branches off `feature/<slug>`'s tip and is merged into the slice's scratch branch before impl runs.
- Final-gate fixes are built on `flow/<slug>/final-iter<m>` and squashed onto `feature/<slug>` as `final-fix:` commits.

`feature/<slug>` is left **rebased, locally gate-green, unpushed, and PR-less** by feature-flow. `/review-loop` (its handoff) pushes the branch, opens the single PR after its Phase 0 dual-engine review passes, and drives CodeRabbit — never merging to `master`; the user owns the merge.

## Cleanup

On success: `feature/<slug>` holds the squashed, one-commit-per-slice (+`final-fix:`) history, rebased and gate-green, ready for `/review-loop`. Leave it and the scratch branches in place.

On `BLOCKED.md`: leave everything — `feature/<slug>`, scratch branches (including failed iterations), worktrees, logs. The user needs them to debug.

Worktrees auto-clean if the agent made no commits (reviewers); committed worktrees (impl agents) stay until the user calls `ExitWorktree` or removes them with `git worktree remove`.
