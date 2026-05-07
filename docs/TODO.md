# Inkstone — TODO

## Status

**Current phase**: MVP complete
**Last updated**: 2026-05-07 (TODO consolidated; pre-MVP Completed graveyard archived)

**Pre-MVP completed-task history**: see [`./.archive/CHANGELOG-pre-MVP.md`](./.archive/CHANGELOG-pre-MVP.md). `git log` remains the authoritative shipped-vs-not source.

## In Progress

- Architecture cleanup stacks (graphite-stacked PRs landing 2026-05-07).
  - Stack A — `sessions.ts` split (#86 alternation repair → #87 listSessions).
  - Stack B — `actions.ts` split (#88 resume → #89 clear → #90 prompt).
  - Stack C — `LayoutContext` migration (#93 scroll → #94 input refs → #95 delete shims).
  - Stack D — docs hygiene (this archive + ARCHITECTURE.md ToC).

## Known Issues

- **Abort-unmount test gap for the approval panel.** The provider's `onCleanup` resolves any in-flight `confirmFn` to `false` (queued via `queueMicrotask`). Verified by code inspection + abort/clearSession test coverage. Direct test coverage via `renderer.destroy()` while pending triggers a Bun 1.3.4 segfault on macOS in the OpenTUI renderer teardown path when a Promise-holding owner is disposed — unrelated to the resolver, but it means we can't assert this specific path end-to-end today. Revisit when Bun / OpenTUI ship a fix.

- `file` DisplayParts are user-bubble-only per the reducer today, but the `DisplayPart` union type does not encode that constraint. `AssistantMessage`'s `<Switch>` intentionally has no `<Match>` for `file` — `<Switch>` with no matching branch renders nothing. If a future reducer change starts pushing `file` parts onto an assistant bubble (e.g. a tool that returns a file attachment), those parts would silently disappear from the rendered frame with no type error or runtime warning. Options for hardening: (a) narrow `DisplayPart` at the assistant seam so `file` is statically unreachable, or (b) add a dev-only `console.warn` on the unhandled branch. Neither is implemented today; revisit when a reducer path for an assistant `file` part is actually needed.

- `dialog-select-grouping.ts`'s `countRows` has a documented off-by-one when a caller mixes uncategorized + categorized options (empty-string bucket at index 0, a non-empty header at index 1). The non-empty header is at `index > 0` so the accumulator charges it the `+2` (header + spacer) even though it's visually the first header. No current caller mixes categories this way — fix alongside the first caller that does. Pinned by a test in `test/dialog-select-grouping.test.tsx` so a future fix surfaces as a visible diff.

- Snapshot reads across `await` in `wrappedActions.prompt` catch (`src/tui/context/agent/actions.ts:handlePreStreamError`). Narrow race: if `clearSession()` runs between the `await agentSession.actions.prompt(text)` and the catch, `store.messages.length - 1` becomes `-1` and the error-recovery branch synthesizes an error bubble into the fresh session. Today the race window is minuscule (the user would need to resume/clear mid-turn while the prompt wrapper is unwinding) and `currentSessionId` is already re-checked before the persistence write. 3-line snapshot fix (capture `sidAtStart` + `lenAtStart` before the await, bail on mismatch) when next in that method.

- `startSessionTitleTask` `.then` callback (`src/tui/context/agent/actions.ts`) can resolve after `currentSessionId` has changed via `clearSession`/`resumeSession`. The guard `if (currentSessionId === params.sessionId)` correctly prevents a stale `setStore("sessionTitle", title)`. The SQL write via `updateSessionTitle(tx, params.sessionId, title)` targets the snapshot `sessionId` unconditionally — that's the intended behavior (the title is still correct for the row it was generated against), but the write happens even if the user resumed another session in the meantime. Documented here so a future contributor doesn't "fix" the guard asymmetry by adding the same check around the persist call.

- pi-ai's Codex provider (`openai-codex-responses.js:buildRequestBody`) forwards `options.temperature` into the OpenAI Responses request body unconditionally, even for reasoning models (every Codex model Inkstone ships with is `reasoning: true`). OpenAI rejects non-default `temperature` on those endpoints with a 400 "Unsupported parameter". `session-title.ts` works around this by omitting `temperature` entirely. If a future caller of `completeSimple` against a Codex reasoning model needs a custom temperature, the right fix is an upstream pi-ai capability check — not a `stripTemperatureForReasoning` wrapper in this repo.

- Existing development SQLite databases must be reset after the session-title schema change because `sessions.title` changed from nullable to `TEXT NOT NULL` under the pre-1.0 reset policy. Run `rm ~/.local/state/inkstone/inkstone.db*` once; this deletes local session history.

- Dependency advisories (upstream-blocked, `bun audit` surfaces them). 5 high, 4 moderate, 1 low as of 2026-05-01. The high cluster is `solid-js@1.9.9 → seroval-plugins@~1.3.0 → seroval<=1.4.0` (prototype pollution, RCE via JSON deserialization, 2× DoS, RegExp DoS). Not actionable without forking `@opentui/solid@0.1.104`, which pins `solid-js: 1.9.11` as an **exact-version peer dependency** (see `node_modules/@opentui/solid/package.json`). solid-js 1.10 doesn't exist (registry has 1.9.x and 2.0.0-experimental.N); overriding seroval to 1.5.x would violate solid-js's `~1.3.0` range check. Moderates: `file-type` (ASF parser infinite loop, via `@opentui/core → jimp`), `uuid<14` (buffer-bounds check in v3/v5/v6, via `pi-coding-agent`), `esbuild<=0.24.2` (dev-server CORS, via `drizzle-kit` — dev-only), `@anthropic-ai/sdk` (insecure default file permissions, via `pi-ai`). Low: `diff 6-8` DoS in parse/apply patch. Re-evaluate when `@opentui/solid` ships a version that relaxes the peer or upgrades `solid-js` past the seroval-vulnerable range. `bun audit` is exposed as `bun run audit` but NOT wired into `bun run ci` — it would fail-shut on every run with no actionable fix.

- Secondary page `"text"` format ships but no caller currently uses it. The first real consumer (subagent work output, plain logs, or structured data) will validate the contract. If the shape needs to widen further — e.g. `format: "jsx"` or a render callback — revisit then; today's markdown-vs-text split covers the documented near-term use cases.

- `openVaultFilePart` in `src/tui/util/file-part-handler.ts` is vault-specific — it hardcodes `VAULT_DIR` path resolution, `isInsideDir` sandbox check, and `readFileSync`. Extracted out of `UserPart` so the rendering layer is decoupled, but the handler itself still assumes every `file` part points at a vault-relative filesystem path. Won't generalize when other agents emit `file` parts pointing at non-vault paths or non-filesystem content. Full fix: widen `DisplayPart.file` with a `source` discriminator (e.g. `"vault" | "web" | ...`) and convert `file-part-handler.ts` into a dispatch table keyed on that field; touches the bridge type, the `parts` schema (`source` column), both current producers (reader's `/article` and `@`-mentions), and serialize/deserialize. Revisit when a second producer emits file parts from a non-vault source — premature today.

- Reader permission shift — with the `activeArticle`-less refactor, reader's permission rules are now static on the whole Articles zone (any article edit → frontmatter-only, any article write → blocked). Previously rules applied only to the *currently-active* article; other articles were effectively edit-free. Re-evaluate if reader ever needs bulk-editing historical articles — today's shape is stricter by default, which fits the primary reading workflow.

- Streaming text may still flash at top on first response (needs live testing).

- Click-to-refocus may not work in all terminal emulators.

- pi-ai Usage type doesn't separate thinking tokens from output tokens.

- Assistant messages persisted before the per-message footer change will render without a footer (no backfill).

- Slash-command parser is naive — see "Robust slash-command parsing" in Future Work. Messages that happen to start with `/article ` will still be consumed as commands under the reader agent, even when that wasn't the user's intent.

- `DialogSelect`'s `rows()` memo has a dormant off-by-one: it keys the "is this the first header?" check on the raw `grouped()` index, so a dialog that mixes an uncategorized bucket (empty-string key, index 0) with a categorized group (index ≥1) gets one extra spacer row in the scrollbox height calculation. No caller mixes today (DialogModel always-categorized; DialogProvider / DialogCommand / DialogTheme / DialogAgent / DialogVariant / reader's `pickFromList` never-categorized). Fix alongside the first caller that needs to mix — filtering empty buckets out of the accumulator is a 2-line change.

- DB migrations folder ships with the source tree but isn't yet bundled for a packaged binary — `migrate()` reads files off disk at `import.meta.dir/migrations`. Fine for `bun run dev`; needs a bundler trick (opencode inlines via `OPENCODE_MIGRATIONS` global) when Inkstone ships as a single executable.

## Future Work (Post-MVP)

- Reader zones-per-command when a second reader command lands. Today `readerAgent.zones` declares workspace paths (`010 RAW/013 Articles`, `020 HUMAN/022 Scraps`, `020 HUMAN/023 Notes`) that happen to match `/article`'s write targets. The zones render in the system prompt via `composeZonesBlock` before command-specific workflow text arrives from `/article`'s opening user message, so when reader grows a second command (e.g. `/book` with different write zones), the static agent-level zones list will over-grant writes for `/book` and under-grant them for `/article`. Likely fix: let `AgentCommand` declare its own `zones: AgentZone[]` and merge them into the prompt + permission overlay when that command's workflow prelude is injected. Deferred per D8 — no second reader command exists yet.

- Move tool-arg summary format from the UI to the tool definition. **Partly done** — the per-tool renderers moved from `src/tui/util/tool-summary.ts` to `src/bridge/tool-renderers.ts` as `TOOL_ARG_RENDERERS: Record<string, (args) => string>`, so the UI no longer owns the catalog. The remaining step — attaching `renderArgs?: (args) => string` to each `AgentTool` object directly (so third-party agents supply their own format without editing the central map) — is still open. Complication: pi-coding-agent's `readTool`/`writeTool`/`editTool` are factory outputs Inkstone doesn't own; a cast-at-import intersection type (or upstream PR to pi-coding-agent) is needed to attach the field. Inkstone-owned tools (`updateSidebarTool`) would just grow a field. Revisit when (a) a second agent lands with its own tools, or (b) we need external agent authors to ship tool-specific renderers.

- Skills system — per-agent markdown bundles loaded from the vault. Layout: `$VAULT/InkStone/skills/<agent>/<skill>/SKILL.md`, YAML frontmatter `{ name, description }` + body. System prompt injects an `<available_skills>` block (name + description + location, composer pattern matches OpenCode / pi-coding-agent). Bodies read on demand via the existing `read` tool — no dedicated `skill` tool. `AgentInfo` grows `skills?: string[]`; composer emits block when non-empty. Deferred intentionally: no real skill content exists yet, and shaping the loader against zero candidates risks landing the wrong filtering model. Revisit when the first 2 real skill bundles exist (either a reader-side skill or the first KB skill).

- `AgentInfo.references?: string[]` — declarative doc-pointer list the composer turns into a "consult these files first" prompt fragment. Today agents hard-code doc paths in `buildInstructions()` strings (reader does this; KB would need `090 SYSTEM/099 LLM Wiki/{schema,policy,workflows/*}.md` when it lands). Revisit when KB arrives — three concrete use cases will validate the shape.

- `write: "deny"` zone policy — the matching rule kind (`blockInsideDirs`) shipped with the reader statelessness refactor and reader uses it today via `getPermissions`. A declarative `deny` zone would map to `blockInsideDirs` in `composeZonesOverlay`; would let agents express read-only-zones as data instead of writing a custom overlay. Small ergonomics win. Deferred per D8 until a second agent wants it.

- Move hard-coded vault paths to user configuration. Today `constants.ts` defines `ARTICLES_DIR`, `SCRAPS_DIR`, `NOTES_DIR`, `TEMPLATES_DIR` as `${VAULT_DIR}/<hard-coded path>`, and agent zone declarations hard-code the same vault-relative paths. Users with non-default vault layouts (different folder names, different numbering schemes) must edit code. Migration: make each agent's zones configurable via `$VAULT/InkStone/agents/<name>.json` (or similar), and derive `constants.ts` values from the same source. D7 (vault ≠ runtime state, amended) committed `$VAULT/InkStone/` as the convention root for this configuration.

- Memory files system — design exploration captured in `docs/MEMORY.md`. `user.md` + `memory.md` under `~/.config/inkstone/`, inlined by `composeSystemPrompt` after `BASE_PREAMBLE`. Read path is low-risk, ship when there's content that wants to live there; write path has real design questions (explicit vs auto, confirmation, overwrite semantics, review flow, per-agent gating) that want lived read-path experience to resolve.

- **Events table / timeline reader** — dropped the writers in the second review pass because they had no readers. Re-add when a history-dialog or timeline view actually needs model-change / thinking-level-change / summary events surfaced.

- **Tree / branching support** — `messages.parent_id` was dropped. Add back (or `turn_id`, depending on the requirement that lands first) when summarization needs turn grouping or when a branching UI arrives. Design it with real requirements, not speculatively.

- **Concurrency — double-launch protection.** Two Inkstone processes can attach to the same active session and interleave writes. Documented in `docs/SQL.md` § Known limitations. Fix options: advisory flock on `DB_FILE`, or `sessions.owner_pid` checked on attach. Not urgent — no fix until this bites someone.

- **Migration bundling for packaged builds.** `migrate()` reads from `import.meta.dir/migrations` at runtime; bundling to a single executable requires inlining (opencode's `OPENCODE_MIGRATIONS` global is the reference pattern). Not relevant until Inkstone ships outside `bun run dev`.

- Per-agent UI beyond prompt color (e.g., agent-specific sidebar info, icons).

- Mid-session agent switching (requires per-message agent stamping on user bubbles and tool-result routing rules — intentionally deferred).

- Effort-variant cycle keybind + slash command (OpenCode uses `ctrl+t` + `/variants`). Palette-only access ships; add when effort becomes a frequently-toggled setting.

- Extract a `MessageErrorPanel` component from `conversation.tsx:81-99` when the abort/error split above lands — at that point the inline block will need real branching (panel vs footer suffix), which justifies the component. Until then a single-variant panel has no polymorphism to pay for the extraction, so it stays inline (matches the "single-consumer, factor out on second consumer" convention called out in `docs/ARCHITECTURE.md:192`).

- More providers (Anthropic direct, OpenAI API-key, Google Vertex, etc.). When a provider needs user-supplied credentials (API key), the OpenRouter path (`src/tui/components/dialog/provider/set-openrouter-key.tsx`) is the reference pattern — single `DialogPrompt.show` + `saveXKey` + scoped `DialogModel.show`. OAuth providers follow Kiro's shape (see `./login-kiro.tsx`).

- Custom providers that bring their own streaming transport (non-pi-ai). Extend `ProviderInfo` with an optional `streamFn` field wired into `Agent` construction. Not speculatively built.

- Multi-session support.

- Session branching/forking.

- Plugin system for custom agents.

- Richer tool rendering (syntax-highlighted code blocks, expandable diffs).

- Reading progress indicator (stage display in header).

- Full theme system (33 themes, dark/light switching, custom themes).

- User-configurable keybinds + leader-chord support (extend `src/tui/util/keybind.ts` with a Zod override schema merged from `config.json`, and port OpenCode's `<leader>X` chord machinery in `tui/context/keybind.tsx`).

- KV persistence for settings (from OpenCode).

- Config file for debug/dev settings (e.g. `KIRO_LOG`, `KIRO_LOG_FILE`) — currently these must be passed as env vars on the command line; a dedicated config file (or a `[dev]` section in `config.json`) would let contributors opt in without editing `package.json`.

- **Port OpenCode's named theme roster.** OpenCode ships ayu, cursor, palenight, rosepine, vercel, kanagawa, etc. as JSON theme files with a color-reference resolver. Inkstone has `dark` / `light` / `catppuccin-mocha` / `dracula` as hand-declared palettes. Separate stack from the approval-UI work — uncoupled, can land anytime.

- **Fenced code block container background.** Fenced code blocks render flat against `theme.background` because OpenTUI's `<markdown>` renderable applies per-scope `foreground` but doesn't paint a full-width block background. OpenCode has the same limitation. Options: (a) investigate whether OpenTUI supports per-block background via a `markup.raw.block` rule extension; (b) extract fenced blocks pre-render and wrap in a `<box backgroundColor={backgroundPanel}>` container. Separate concern from token colors; track when a real bake of the new `markdownCode` token lands in phase 2.

- **`DialogConfirm` unification with the bottom approval panel.** After phase 5 lands, the provider-disconnect flow (`src/tui/components/dialog/provider/confirm-and-disconnect.ts`) still uses `DialogConfirm`. Migrate it onto the same `PermissionPrompt` / scoped-signal pattern so there's one confirmation surface, not two. Low priority — the provider-disconnect flow is rarely hit.

- **"Allow always" for confirmDirs approvals.** Today the bottom panel (phase 5) exposes `Allow once` / `Reject`. OpenCode's panel also has `Allow always` that persists a pattern into the user's policy. Implementing this requires a policy-write path into the zone config — the permission dispatcher today reads zones as static data. Revisit if approval fatigue becomes real.
