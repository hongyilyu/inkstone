# Inkstone — Plan

## Goal

A terminal UI application for guided article reading, built with OpenTUI (Solid) and pi-agent-core. The article reader is the first agent; the project is designed to host more agents later.

## Constraints

- File operations scoped to `VAULT_DIR` (`/home/hongyi/Documents/Obsidian/LifeOS`) only
- Bedrock provider only (initially)
- No plugin system
- No multi-session (one article per session)
- No worker threads — agent runs in-process

## Source References

| Reference | Path |
|-----------|------|
| Article reader extension | `/home/hongyi/dev/pi-dev/extensions/article-reader.ts` |
| OpenCode TUI | `/home/hongyi/dev/opencode/packages/opencode/src/cli/cmd/tui/` |
| OpenCode UI primitives | `/home/hongyi/dev/opencode/packages/opencode/src/cli/cmd/tui/ui/` |
| OpenCode contexts | `/home/hongyi/dev/opencode/packages/opencode/src/cli/cmd/tui/context/` |
| OpenCode themes | `/home/hongyi/dev/opencode/packages/opencode/src/cli/cmd/tui/context/theme/` |
| OpenCode model dialog | `/home/hongyi/dev/opencode/packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` |
| OpenCode edit tool | `/home/hongyi/dev/opencode/packages/opencode/src/tool/edit.ts` |
| OpenTUI skill refs | `/home/hongyi/dev/pi-dev/.agents/skills/opentui/references/` |

## Dependencies

| Package | Role |
|---------|------|
| `@opentui/core` | Terminal renderer |
| `@opentui/solid` | Solid reconciler for OpenTUI |
| `solid-js` | Reactive UI framework |
| `@mariozechner/pi-agent-core` | Headless LLM agent (loop, tools, hooks) |
| `@sinclair/typebox` | Tool parameter schemas |
| `@solid-primitives/event-bus` | Event batching |
| `fuzzysort` | Fuzzy search in dialogs |
| `diff` | Unified diff generation for edit_file tool |

## Phases

| Phase | Scope | Success Criteria |
|-------|-------|-----------------|
| 0 | Install deps, create docs | Deps install clean, docs exist |
| 1 | Copy UI infra from OpenCode + build app shell | `bun run dev` renders themed shell with working input |
| 2 | Agent integration (pi-agent-core + streaming) | Send message → streaming response renders |
| 3 | File tools + quote_article + guard + `/article` | `/article file.md` → Stage 1, guards enforced |
| 4 | Model selection dialog (Bedrock) | Switch model, next prompt uses it |
| 5 | Session persistence (JSON) | Quit + restart preserves conversation |

## Agent Workflow (Article Reader)

The agent follows a 6-stage reading workflow driven entirely by prompt instructions:

1. **Mode selection** — determine `reading_intent` (joy/keeper)
2. **Pre-read** — provide comprehension prompts (keeper) or encourage relaxed reading (joy)
3. **Post-read recap** — ask for rough recap
4. **Discussion** — sharpen understanding via short questions
5. **Preserve or close** — scraps, notes, or nothing
6. **Complete** — mark `reading_completed` in frontmatter

## File Tool Specs

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `read_file` | `{ path }` | File content | Scoped to VAULT_DIR |
| `edit_file` | `{ path, oldText, newText }` | Unified diff | Replace first match, return diff |
| `write_file` | `{ path, content, append? }` | Confirmation | Create dirs if needed |
| `quote_article` | `{ query }` | Matching paragraphs | Search active article by substring |

## Guard Logic

- **Article file**: frontmatter edits allowed, content edits blocked, full writes blocked
- **Notes/scraps dirs**: user confirmation prompt before any write
- **All other paths outside VAULT_DIR**: rejected
