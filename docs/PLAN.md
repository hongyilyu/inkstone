# Inkstone — Plan

## Goal

A terminal UI application for guided article reading, built with OpenTUI (Solid) and pi-agent-core. The article reader is the first agent; the project is designed to host more agents later.

## Constraints

- File operations scoped to `VAULT_DIR` (`/home/hongyi/Documents/Obsidian/LifeOS`) only
- Bedrock is the first provider; more drop in through `src/backend/providers/`
- No plugin system
- No multi-session (one article per session)
- No worker threads — agent runs in-process
- Biome enforces layer and agent import boundaries: the TUI consumes `@backend/agent` public APIs, and the agent shell does not deep-import custom-agent tool internals.

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
| `@mariozechner/pi-coding-agent` | Built-in read / write / edit tool factories (Inkstone delegates rather than reimplementing) |
| `@sinclair/typebox` | Tool parameter schemas |
| `@solid-primitives/event-bus` | Event batching |
| `fuzzysort` | Fuzzy search in dialogs |
| `diff` | Unified diff generation for edit_file tool |
| `drizzle-orm` | Typed SQLite schema + queries (persistence layer) |
| `drizzle-kit` (dev) | Migration generation for the SQLite schema |

## Phases

| Phase | Scope | Success Criteria |
|-------|-------|-----------------|
| 0 | Install deps, create docs | Deps install clean, docs exist |
| 1 | Copy UI infra from OpenCode + build app shell | `bun run dev` renders themed shell with working input |
| 2 | Agent integration (pi-agent-core + streaming) | Send message → streaming response renders |
| 3 | File tools + quote_article + guard + `/article` | `/article file.md` → Stage 1, guards enforced |
| 4 | Model selection dialog (Bedrock) | Switch model, next prompt uses it |
| 5 | Session persistence (JSON) | Quit + restart preserves conversation |
| 6 | SQLite persistence via Drizzle | Session transcripts + raw AgentMessages persist agent-scoped; resume restores full LLM context; `memory` table scaffolded for summarization phase |
| 7 | Agent architecture refactor — zones as declarative workspace | `AgentInfo.zones` feeds both the permission dispatcher and the system-prompt `<your workspace>` block; reader's directory-level `confirmDirs` rules collapse into zone data; 6-case parity vs pre-refactor guard decisions |

## Agent Workflow (Article Reader)

The agent follows a 6-stage reading workflow driven entirely by prompt instructions:

1. **Mode selection** — determine `reading_intent` (joy/keeper)
2. **Pre-read** — provide comprehension prompts (keeper) or encourage relaxed reading (joy)
3. **Post-read recap** — ask for rough recap
4. **Discussion** — sharpen understanding via short questions
5. **Preserve or close** — scraps, notes, or nothing
6. **Complete** — mark `reading_completed` in frontmatter

## File Tool Specs

Tool implementations come from `@mariozechner/pi-coding-agent` (see `src/backend/agent/tools.ts`). Inkstone passes `VAULT_DIR` as the tool's `cwd`; the `beforeToolCall` guard enforces the vault boundary since pi-coding-agent's tools themselves do not sandbox.

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `read` | `{ path, offset?, limit? }` | File content (+ image attachment for image files) | Vault-relative paths resolve under VAULT_DIR. Truncates to ~2000 lines / ~50 KB by default |
| `edit` | `{ path, edits: [{ oldText, newText }, ...] }` | Unified diff | Multi-edit in one call. Mutation-queued. Guard iterates each `oldText` when editing the active article (all must target frontmatter) |
| `write` | `{ path, content }` | Confirmation | Overwrite-only; creates parent dirs. Mutation-queued |

## Guard Logic

- **Article file**: frontmatter edits allowed, content edits blocked, full writes blocked
- **Notes/scraps dirs**: user confirmation prompt before any write
- **All other paths outside VAULT_DIR**: rejected
