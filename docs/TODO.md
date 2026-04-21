# Inkstone — TODO

## Status

**Current phase**: MVP complete
**Last updated**: 2026-04-21 (footer field-scope docs)

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

## In Progress

(nothing)

## Known Issues

- [ ] Streaming text may still flash at top on first response (needs live testing)
- [ ] Click-to-refocus may not work in all terminal emulators
- [ ] pi-agent-core message history not restored on session load (only display messages)
- [ ] Accumulated token/cost totals not persisted across session restores (resets on app restart; per-message footer is unaffected)
- [ ] pi-ai Usage type doesn't separate thinking tokens from output tokens
- [ ] Assistant messages persisted before the per-message footer change will render without a footer (no backfill)

## Future Work (Post-MVP)

- [ ] Multi-agent shell (agent switcher, per-agent UI)
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
