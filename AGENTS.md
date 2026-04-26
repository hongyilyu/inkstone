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


## Plan Review Protocol

Before presenting any multi-step plan or non-trivial code change to the user, invoke the `behavioral-guidelines` skill/agent to review the proposed approach. The reviewer checks for overcomplication, over-engineering, unnecessary abstractions, speculative features, and missing success criteria. Apply the reviewer's minimal fixes before presenting the plan to the user.


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
