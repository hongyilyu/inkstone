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


## Source References

- OpenCode TUI: `~/dev/opencode/packages/opencode/src/cli/cmd/tui/`
- OpenTUI skill: `.agents/skills/opentui/`
- pi-agent-core types: `node_modules/@mariozechner/pi-agent-core/`
- pi-ai types: `node_modules/@mariozechner/pi-ai/dist/types.d.ts`
