# Inkstone Architecture Simplification Review Plan

**Status**: Implemented
**Date**: 2026-05-07

This plan records the architecture review findings and the proposed simplification path. It was reviewed against the `behavioral-guidelines` skill before being written down.

## Summary

The main architecture risk is that agent `zones` are documented like write workspaces but implemented mostly as confirmation regions. The recommended fix is to make the documented model true: reads stay vault-wide, while mutating file tools write only inside declared zones.

The secondary improvements are to remove the global layout escape hatch, add a small permission-coverage guard for composed tools, and reconcile stale docs that describe abandoned or already-shipped designs.

## Recommended Changes

### 1. Make agent zones a real write allowlist

- Treat `AgentInfo.zones` as the authoritative write workspace for mutating file tools.
- Keep reads vault-wide.
- For `write_file` and `edit_file`, compose an `insideDirs` rule from all declared zones before applying zone-specific confirmation rules.
- Preserve stricter agent-specific rules:
  - reader article writes remain blocked;
  - reader article edits remain frontmatter-only;
  - edits inside confirmation zones still require approval.
- Update permission tests that currently assert unzoned vault writes are allowed.

Decision: prefer the safety-oriented interpretation of zones over the current advisory-only behavior. If a future agent needs vault-wide writes, it should declare that explicitly rather than inheriting broad write access by omission.

Primary files:

- `src/backend/agent/zones.ts`
- `src/backend/agent/types.ts`
- `src/backend/agent/permissions.ts`
- `test/permissions.test.ts`

### 2. Remove the global layout singleton path

- Reorder the TUI provider stack so `LayoutProvider` wraps `AgentProvider`.
- Have `AgentProvider` consume `useLayout()` and pass layout dependencies into actions, reducer helpers, and command handlers.
- Remove direct production imports of `getActiveLayout()`.
- Update the TUI test harness to expose layout through the provider stack instead of relying on module-global state.

Decision: keep the existing layout capabilities, but make ownership explicit through provider dependencies. Do not introduce a new event bus or cross-context service.

Primary files:

- `src/tui/app.tsx`
- `src/tui/context/layout.tsx`
- `src/tui/context/agent/provider.tsx`
- `test/tui/harness.tsx`

### 3. Add tool permission coverage checks

- Export a small `hasBaseline(toolName)` helper from the permission registry.
- During tool composition, assert that every composed tool either:
  - has a registered filesystem baseline, or
  - is explicitly listed as path-free with a short reason.
- Add tests so future tools cannot accidentally run without a reviewed permission model.

Decision: use a small allowlist guard rather than porting a larger OpenCode-style ruleset before Inkstone has the complexity to justify it.

Primary files:

- `src/backend/agent/permissions.ts`
- `src/backend/agent/compose.ts`
- `test/agent-compose.test.ts` or a focused permission test

### 4. Consolidate stale docs

- Update `docs/ARCHITECTURE.md` so it matches the current split provider/reducer layout, current `DisplayPart` shape, and shipped `suggest_command` flow.
- Update `docs/AGENT-DESIGN.md` so command execution docs match the current `execute(args, helpers)` contract.
- Update `docs/SKILLS.md` so skill paths and base-tool descriptions match the latest intended design.
- Rewrite or archive outdated exploration in `docs/SLASH-COMMANDS.md`; the dropdown exists, so the old "no dropdown UI yet" state should not remain authoritative.
- Convert `docs/PLAN.md` into a current roadmap or historical archive. It still describes pre-session-list and dropped persistence ideas.
- Keep `docs/SQL.md` mostly unchanged; the persistence design is coherent and does not need a speculative split.

Decision: make `ARCHITECTURE.md`, `SQL.md`, and `TODO.md` the canonical current-state docs. Treat older design notes as historical unless they are actively maintained.

## Explicit Non-Changes

- Do not rewrite the large agent reducer into a new event bus or bridge layer.
- Do not split persistence further unless a persistence task requires it.
- Do not remove typed slash-command dispatch in this pass.
- Do not implement memory, skills, plugin, or provider roadmap items as part of this cleanup.
- Do not add broad abstractions for hypothetical future agents.

## Test Plan

- Run existing permission tests and add coverage for:
  - write and edit inside a declared zone;
  - write and edit outside all declared zones;
  - article write blocking and article frontmatter edit confirmation;
  - compose-time failure or test failure for tools without baseline coverage.
- Run TUI tests covering prompt suggestions, resume, clear, and command flows after provider reordering.
- Run `bun run ci`.
- Treat the existing `DataPathsManager` listener warning from TUI tests as test-harness hygiene unless it becomes a failure.

## Baseline Observations

- `bun run ci` passed before this plan was written: 434 tests, 0 failures.
- The repo currently has large but coherent modules. The largest files are `reducer.ts`, `prompt.tsx`, `sessions.ts`, `agent/index.ts`, `message.tsx`, and `permissions.ts`.
- The size of those files is not enough by itself to justify a broad refactor; the recommended work targets semantic drift and global-state coupling first.

## Assumptions

- "Zones" should mean workspace/write scope, not merely confirmation scope.
- Vault-wide reads remain acceptable for current agents.
- OpenCode remains the UI reference, but Inkstone should port only the provider/dependency pattern needed here.
- Documentation cleanup is included because project instructions require docs maintenance when architecture constraints or plans change.
