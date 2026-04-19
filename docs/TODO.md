# Inkstone — TODO

## Status

**Current phase**: 1 → 2 (transitioning)
**Last updated**: 2026-04-19

## Completed

- [x] Project scaffolded (OpenTUI Solid + Bun)
- [x] Dependencies installed (pi-agent-core, typebox, event-bus, fuzzysort, diff)
- [x] Documentation created (PLAN.md, ARCHITECTURE.md, TODO.md)
- [x] Phase 1: App shell working
  - context/helper.tsx (createSimpleContext factory)
  - context/theme.tsx (dark theme with RGBA colors)
  - ui/dialog.tsx (stack-based modal system)
  - ui/dialog-confirm.tsx (promise-based confirmation)
  - ui/toast.tsx (toast notifications)
  - components/header.tsx, footer.tsx, conversation.tsx, input.tsx
  - app.tsx (provider stack + layout)
  - Verified: `bun run dev` renders themed shell with working input
- [x] Phase 2: Agent integration
  - Bedrock streaming verified with live API call
  - Messages render in conversation view
  - System prompt active (reading workflow)
- [x] Phase 3: File tools + guard + /article command
  - read_file, edit_file (with diff), write_file tools (VAULT_DIR scoped)
  - quote_article tool (paragraph search)
  - beforeToolCall guard (frontmatter protection + notes/scraps confirm dialog)
  - /article command wires system prompt + triggers Stage 1

## In Progress

- [ ] Phase 4: Model selection dialog (Bedrock)

## Upcoming

- [ ] Phase 2: Agent integration (pi-agent-core + streaming)
- [ ] Phase 3: File tools + quote_article + guard + `/article` command
- [ ] Phase 4: Model selection dialog (Bedrock)
- [ ] Phase 5: Session persistence (JSON)

## Future Work (Post-MVP)

- [ ] Multi-agent shell (agent switcher, per-agent UI)
- [ ] More providers beyond Bedrock (Anthropic direct, OpenAI, etc.)
- [ ] Multi-session support
- [ ] Session branching/forking
- [ ] Plugin system for custom agents
- [ ] Richer tool rendering (syntax-highlighted code blocks, expandable diffs)
- [ ] Article file picker dialog (list files in ARTICLES_DIR)
- [ ] Reading progress indicator (stage display in header)
