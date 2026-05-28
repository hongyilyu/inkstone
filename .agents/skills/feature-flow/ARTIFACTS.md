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
│   │   ├── OPEN-QUESTIONS.md    # ambiguities found mid-slice (optional)
│   │   └── BLOCKED.md           # only if this slice halted the flow
│   ├── 2/...
│   └── N/...
├── REPORT.md                    # written on full success
├── BLOCKED.md                   # written if any slice hit its retry cap
└── SUMMARY.md                   # always written last; friction-signal digest for skill revision
```

Worktrees are created by the `Agent` tool's `isolation: "worktree"` mode. The harness picks the path. Record returned paths in `STATE.md`.

## STATE.md format

Append-only, newest at the bottom. One line per event. Format:

```
<ISO-8601 timestamp>  <scope>  <event>  <detail>
```

Scope is `flow` for top-level events or `slice-<n>` for slice-scoped events.

Top-level events (scope `flow`):

- `started`
- `done` — REPORT.md written
- `blocked` — BLOCKED.md written
- `summary-written` — SUMMARY.md written; final event

Slice events (scope `slice-<n>`):

- `decomposed`
- `contract-skipped` | `contract-merged`
- `impl-spawned` (with worktree path) | `impl-done`
- `review-spawned` | `review-done`
- `verify-pass` | `verify-fail`
- `iter-end` (when respawning for another iteration)
- `passed` (slice green, moving to next)
- `blocked` (this slice hit retry cap)

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
