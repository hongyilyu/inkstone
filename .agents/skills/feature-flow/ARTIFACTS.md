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
├── FINAL-REVIEWS/               # written by the Final review phase
│   ├── 1/
│   │   ├── correctness.md
│   │   ├── integration.md
│   │   ├── tests.md
│   │   └── adr.md
│   └── 2/                        # iteration 2 (only on final-review retry)
├── FINAL-VERIFY/                # written by the Final review phase's deterministic gates
│   ├── 1.md
│   └── 2.md
├── FINAL-ADVISORY-DEFERRED.md   # feature-level advisories triaged as `defer` (optional)
├── REPORT.md                    # written on full success, AFTER the Final review phase passes
├── BLOCKED.md                   # written if any slice or the final review hit its retry cap
└── SUMMARY.md                   # always written last; mechanical digest
```

Worktrees are created by the `Agent` tool's `isolation: "worktree"` mode. The harness picks the path. Record returned paths in `STATE.md`.

## STATE.md format

Append-only, newest at the bottom. One line per event. Format:

```
<ISO-8601 timestamp>  <scope>  <event>  <detail>
```

Scope is `flow` for top-level events, `slice-<n>` for slice-scoped events, or `final` for Final-review-phase events.

Top-level events (scope `flow`):

- `started` — detail includes `feature-base=<sha>` (the master SHA captured at flow start; the Final review phase reads it from here)
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
- `passed` (slice green, moving to next)
- `blocked` (this slice hit retry cap)

Final-review events (scope `final`):

- `gates-spawned` | `gates-pass` | `gates-fail`
- `reviewers-spawned` | `reviewers-done`
- `advisory-triaged` (with `addressed=<n> deferred=<n>`)
- `iter-end` (final-review retry)
- `final-review-passed`
- `blocked` (final review hit its retry cap)

## Branch model

Stacked. Each slice is a branch on top of the previous.

```
master
└── flow/<slug>/slice-1                ← off master
    ├── flow/<slug>/slice-1-iter2      ← retry, off slice-1's parent (master)
    └── flow/<slug>/slice-2             ← off slice-1 (the passing version)
        └── flow/<slug>/slice-3         ← off slice-2
            └── ...
```

Per-slice details:
- A retry iteration creates `flow/<slug>/slice-<n>-iter<m>` off the slice's *parent* (i.e., not off the failing iteration). Failed iterations are kept for diff/debugging but not stacked on.
- The contract phase, when present, branches off the slice's parent and is merged into the slice's main branch before impl runs.

The whole stack lives until the user merges. The user owns the merge — `/feature-flow` never pushes or merges to `master`.

## Cleanup

On success: leave artifacts and branches in place. The user reviews the stack and decides how to land it (squash all, merge each, rebase onto master).

On `BLOCKED.md`: leave everything — branches (including failed iterations), worktrees, logs. The user needs them to debug.

Worktrees auto-clean if the agent made no commits (reviewers); committed worktrees (impl agents) stay until the user calls `ExitWorktree` or removes them with `git worktree remove`.
