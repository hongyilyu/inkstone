# Inkstone — Agent Instructions

## Docs

Update on task start/finish:

- `docs/PLAN.md` — features, constraints, phases
- `docs/ARCHITECTURE.md` — data flow, store schema, component hierarchy, file structure
- `docs/TODO.md` — lifecycle (In Progress → Completed), Known Issues, "Last updated" date

**Start:** add to TODO "In Progress"; note arch changes in ARCHITECTURE.
**Done:** move TODO → "Completed"; update arch + Known Issues; bump date.

Domain-specific reading rules:

- **UI change** (components, rendering, theming, layout, dialogs, keybinds, scroll/focus, status lines, markdown/code) → first consult OpenCode TUI at `../opencode/packages/opencode/src/cli/cmd/tui/`. Port (trimmed) over invent. Too heavy → state explicitly + justify simpler variant.
- **`src/backend/persistence/` change** (schema, migrations, session lifecycle, write split, load-time repair, anything SQLite) → read `docs/SQL.md` first. Single source of truth. Update alongside schema/API changes.


## Pre-Commit

1. `bun run check` — Biome format + safe lint fixes. Run **before** `git add` so fixes get staged.
2. `bun run ci` — Biome check + `bun test`. Must pass.

Both lint full `src/` + `test/` via `biome.json` `files.includes`. Don't pass `./src` argv — silently re-scopes to source-only, regresses test coverage.

`ci` fails on pre-existing issues → surface to user, don't commit past them.

`bun run audit` periodically (not per commit) for **critical** CVEs. High/mod/low advisories blocked by `@opentui/solid`'s exact `solid-js@1.9.11` peer — tracked in `docs/TODO.md` Known Issues. Script pins `--audit-level=critical`. Full list: `bun audit` bare.


## Tests

Tests = completion gate.

**Done:** `bun run ci` all green. Failures your change caused = part of task. Verify "unrelated" via `git diff` + `git stash` toggle. Genuinely pre-existing → surface with evidence.

**New feature ships with tests:**

- Backend (agent, persistence, permissions, providers, tools, utils) → `test/`. See `test/permissions.test.ts`, `persistence-failure.test.ts`, `mentions.test.ts`, `resume-repair.test.ts`.
- TUI (components, reducer, keybinds, dialogs, rendering) → `test/tui/`. Use `renderApp()` (`test/tui/harness.tsx`) + `makeFakeSession()` (`test/tui/fake-session.ts`). Script synthetic `AgentEvent`s through real reducer; assert via `captureCharFrame()` substrings — no snapshots. See `test/tui/conversation.test.tsx`, `prompt.test.tsx`, `dialogs.test.tsx`.

Skips named in PR: pure visual (char-frame can't assert), branch covered by adjacent test, seam change too invasive (defer to TODO).

**Flake policy:** timing-sensitive (streaming, interrupt, autocomplete) → run 3× back-to-back before commit. Flaky → widen `waitForFrame` timeout/poll. Never ship flaky.


## Review

**Before non-trivial change** (mandatory > 50 LOC source; tests + docs excluded; added + removed): invoke `behavioral-guidelines` skill. Checks overcomplication, over-engineering, unnecessary abstractions, speculative features, missing success criteria. Apply minimal fixes before user sees plan. Optional but encouraged for smaller multi-file or new-pattern changes.

Prefer long-term proper fix over short-term smaller diff — unless proper fix needs speculative infra. Smaller diff alone ≠ justification. When in doubt, port upstream OpenCode pattern in full over trimmed local variant.

**After non-trivial impl** — spawn fresh-context subagent before declaring done:

1. No main-agent context → reviewer forms opinion from diff + code alone. Bias reduction = the point.
2. Pass concise "known limitations" (consciously accepted trade-offs) so reviewer skips already-decided issues.
3. Evaluate every comment. Address valid; justify dismissals. Record both in user response.
4. Don't blindly apply. Context-less reviewers over-index on style/speculative risk. Main agent final say.


## References

**Source code / types:**

- OpenCode TUI: `../opencode/packages/opencode/src/cli/cmd/tui/`
- pi-mono: `../pi-mono/`

**Agent skills config:**

- Issue tracker → GitHub Issues at `hongyilyu/inkstone` via `gh` CLI. See `docs/agents/issue-tracker.md`.
- Triage labels → `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- Domain docs → single-context. `docs/CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
