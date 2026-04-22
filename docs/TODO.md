# Inkstone — TODO

## Status

**Current phase**: MVP complete
**Last updated**: 2026-04-21 (multi-agent shell + session-persisted agent + /article reader-gate)

## Completed

- [x] Phase 0: Project scaffolded, deps installed, docs created
- [x] Phase 1: App shell (theme, dialog, toast, components)
- [x] Phase 2: Agent integration (Bedrock streaming verified)
- [x] Phase 3: File tools + guard + /article command
- [x] Phase 4: Model selection dialog (Ctrl+M, fuzzy search)
- [x] Phase 5: Session persistence (JSON save/restore, /clear command)
- [x] Fix: streaming text in-place growth (produce pattern from OpenCode)
- [x] Fix: focus management (prompt always focused, click-refocus, scroll keybinds)
- [x] Last-turn status line between conversation and prompt (agent, model, duration, input/output tokens)
- [x] Markdown rendering for assistant messages (concealed syntax markers, inline/block code styling, list/quote/heading formatting, reactive to theme switch)
- [x] Fix: destroy stale `SyntaxStyle` on theme switch and provider teardown to release FFI-backed native resources
- [x] Fix: per-message status line (agent/model/duration stored on each `DisplayMessage`, rendered below every assistant reply, survives model switches and session restores)
- [x] Fix: footer boundaries follow pi-agent-core's `message_start`/`message_end` events — one display bubble per assistant message boundary, with model name sourced from the event itself (not the mutable `store.modelName`). Tool-driven turns now show a distinct, correctly-labeled footer for each assistant reply, and mid-stream Ctrl+P model switches do not relabel in-flight replies.
- [x] Docs: clarify `DisplayMessage` footer field scopes — `agentName`/`modelName` are per-message (stamped in `message_end` from the assistant event), `duration` is per-turn (stamped in `agent_end` on the turn-closing assistant bubble only). Intermediate assistant bubbles in tool turns correctly persist/render without a duration pip.
- [x] Refactor: split `src/` into three layers with enforced dependency direction — `backend/` (headless agent, tools, persistence), `bridge/` (shared view-state types: `DisplayMessage`, `AgentStoreState`, `SessionData`), `tui/` (Solid + OpenTUI UI). Dependency graph: `tui → bridge, backend`; `backend → bridge` (types only); `bridge → nothing`. Enables parallel backend/frontend work and sets up a swappable frontend in the future.
- [x] Tooling: add Biome (lint + format) with path aliases (`@backend/*`, `@bridge/*`, `@tui/*`) and `noRestrictedImports` overrides that mechanically enforce the layer boundary rules. `bun run ci` is the single CI-ready command. Mass format pass migrated the codebase to Biome defaults (tabs, semicolons, 80-char lines).
- [x] Multi-agent shell: static registry (`backend/agent/agents.ts`) with two agents — `reader` (existing Obsidian reading guide, 4 tools, `secondary` accent) and `example` (placeholder chat assistant, no tools, `accent` accent). `Tab` / `Shift+Tab` cycle agents on the open page; switching is locked once the session has messages (diverges from OpenCode's always-on `agent_cycle` to match Inkstone's "one agent per session" model). Current agent persists to `config.json` alongside `modelId`/`themeId`. Prompt label + input border + user-bubble border + assistant-footer `▣` glyph all derive their color from the active agent's `colorKey`. Command-palette entry shown only on the open page. Bubble-footer `agentName` now stamped with the active agent's `displayName` at `message_end`.
- [x] Fix (review): `/article` is now gated on the reader agent — on any other agent the text falls through as a normal prompt (avoids a broken reading flow under an agent that has no article tools).
- [x] Fix (review): `currentAgent` is persisted inside `session.json` and wins over `config.json` on restore, so a transcript always reopens under the agent that produced it, regardless of any intervening config drift. Legacy sessions without the field still fall through to config.

## In Progress

(nothing)

## Known Issues

- [ ] Streaming text may still flash at top on first response (needs live testing)
- [ ] Click-to-refocus may not work in all terminal emulators
- [ ] pi-agent-core message history not restored on session load (only display messages)
- [ ] Accumulated token/cost totals not persisted across session restores (resets on app restart; per-message footer is unaffected)
- [ ] pi-ai Usage type doesn't separate thinking tokens from output tokens
- [ ] Assistant messages persisted before the per-message footer change will render without a footer (no backfill)
- [ ] Slash-command parser is naive — see "Robust slash-command parsing" in Future Work. Messages that happen to start with `/article ` will still be consumed as commands under the reader agent, even when that wasn't the user's intent.

## Future Work (Post-MVP)

- [ ] Robust slash-command parsing (token-first, registry-driven; replace naive `startsWith`/equality checks in `prompt.tsx`). The current parser will misidentify messages that happen to begin with `/article ` or equal `/clear`. A real parser should recognize only the leading token, dispatch through a per-command registry, and be optionally scoped per agent.
- [ ] Per-agent UI beyond prompt color (e.g., agent-specific sidebar info, icons)
- [ ] Mid-session agent switching (requires per-message agent stamping on user bubbles and tool-result routing rules — intentionally deferred)
- [ ] More providers beyond Bedrock (Anthropic direct, OpenAI, etc.)
- [ ] Multi-session support
- [ ] Session branching/forking
- [ ] Plugin system for custom agents
- [ ] Richer tool rendering (syntax-highlighted code blocks, expandable diffs)
- [ ] Article file picker dialog (list files in ARTICLES_DIR)
- [ ] Reading progress indicator (stage display in header)
- [ ] Full theme system (33 themes, dark/light switching, custom themes)
- [ ] Keybind system with leader key (from OpenCode)
- [ ] KV persistence for settings (from OpenCode)
