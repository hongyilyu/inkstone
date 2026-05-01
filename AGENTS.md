# Inkstone — Agent Instructions

## Documentation Protocol

When starting or completing any task, update the relevant docs in `docs/`:

- `docs/PLAN.md` — update when adding new features, changing constraints, or adding phases
- `docs/ARCHITECTURE.md` — update when changing data flow, store schema, component hierarchy, or file structure
- `docs/TODO.md` — update when starting a task (add to "In Progress"), completing (move to "Completed"), or discovering issues (add to "Known Issues")

### On task start

1. Add the task to `docs/TODO.md` under "In Progress"
2. If the task changes architecture, note the planned changes in `docs/ARCHITECTURE.md`

### On task completion

1. Move the task from "In Progress" to "Completed" in `docs/TODO.md`
2. Update `docs/ARCHITECTURE.md` if store fields, components, or data flow changed
3. Add any discovered limitations to "Known Issues" in `docs/TODO.md`
4. Update the "Last updated" date in `docs/TODO.md`


## Pre-Commit Protocol

Before creating any git commit, run `bun run check` (Biome format + safe lint auto-fixes) and then `bun run ci` (Biome check + `bun test`). The `ci` step must pass. This keeps the tree format-clean so review diffs stay focused on semantic changes, not whitespace churn.

`bun run check` and `bun run ci` both lint the full `src/` + `test/` tree — `biome.json`'s `files.includes` is the single source of truth, so the `./src` argv is deliberately absent from the scripts. Adding `./src` argv back would silently re-scope lint to source-only and regress test-dir coverage.

Order matters: `bun run check` writes fixes, so running it *before* `git add` catches format drift in the files you're about to stage. Running `bun run ci` after confirms the staged version lints clean.

If `bun run ci` fails on unrelated pre-existing issues, surface the failures to the user rather than silently committing past them.

Run `bun run audit` periodically (not on every commit) to surface any **critical**-severity dependency CVEs. Known upstream-blocked advisories (high/moderate/low) are tracked in `docs/TODO.md` Known Issues — those can't be fixed without breaking `@opentui/solid`'s `solid-js@1.9.11` exact-version peer, so the script pins `--audit-level=critical` to let the existing advisories pass (exit 0) while still flagging any future critical. For the full advisory list, run `bun audit` bare.


## Plan Review Protocol

Before presenting any multi-step plan or non-trivial code change to the user, invoke the `behavioral-guidelines` skill/agent to review the proposed approach. The reviewer checks for overcomplication, over-engineering, unnecessary abstractions, speculative features, and missing success criteria. Apply the reviewer's minimal fixes before presenting the plan to the user.


## Post-Implementation Review Protocol

After completing any non-trivial implementation, spawn a fresh-context subagent to review the changes before considering the task done. Contract:

1. **Do not pass any context from the main agent's conversation to the subagent.** The subagent must form its opinion from the diff and code alone. Bias reduction is the whole point.
2. **Do pass a concise "known limitations" note** — things the main agent consciously accepted (e.g. "behavioral widening is intentional, see TODO Known Issues") — so the reviewer doesn't waste cycles re-raising already-decided trade-offs.
3. **Evaluate every reviewer comment.** Address the ones that hold up; explicitly justify dismissals for the ones that don't. Record both outcomes in the response to the user.
4. **Do not blindly apply reviewer suggestions.** Reviewers without context can over-index on style or speculative risks; the main agent has final say.


## UI Reference Protocol

For any UI-side change (components, rendering, theming, layout, dialogs, keybinds, scroll/focus behavior, status lines, markdown/code display, etc.), **always consult the OpenCode TUI codebase at `../opencode/packages/opencode/src/cli/cmd/tui/` first** to see how the same concern is handled there before designing a solution. Inkstone tracks OpenCode's patterns — prefer porting the existing approach (trimmed to Inkstone's scope) over inventing a new one. When the OpenCode approach is too heavy for Inkstone's needs, state that explicitly in the plan and justify the simpler variant.


## Source References

- OpenCode TUI: `../opencode/packages/opencode/src/cli/cmd/tui/`
- OpenTUI skill: `.agents/skills/opentui/`
- pi-agent-core types: `node_modules/@mariozechner/pi-agent-core/`
- pi-ai types: `node_modules/@mariozechner/pi-ai/dist/types.d.ts`

## Persistence

For any change to `src/backend/persistence/` — schema, migrations,
session lifecycle, the write split, load-time repair, or anything
that touches SQLite — read `docs/SQL.md` first. It is the single
source of truth for the persistence layer's design decisions,
invariants, and recipes. Update it alongside any schema or API
change.
