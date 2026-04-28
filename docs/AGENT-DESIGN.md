# Inkstone — Agent System Design

This doc captures the **why** behind Inkstone's agent system. Implementation details live in [`ARCHITECTURE.md`](./ARCHITECTURE.md) under "Agent Registry"; active and future work is tracked in [`TODO.md`](./TODO.md). Read this when you want to understand the shape of the decisions, what alternatives were considered, and where future features are designed to plug in.

## Status

Shipped in PR #1 (branch `refactor/agent-shell-base-layer`). The base layer + folder-per-agent structure is in place. Two agents ship today: Reader and Example. Skills, memory, per-agent permissions, subagents, and user-defined agents are intentionally not built yet — see "Extension points" for how they are designed to land without restructuring.

## Goals

1. **Easy to add agents.** Adding a new agent is a local change — a new folder under `backend/agent/agents/` + one line in the registry assembler (`backend/agent/agents.ts`). No edits to the shell (`backend/agent/index.ts`), the TUI, the config schemas, or any other agent's folder.
2. **Shared behavior lives in one place.** Things every agent needs — a foundation tool, a shared prompt fragment, a memory-read at session boot — live in `backend/agent/base/`, not duplicated across agent folders.
3. **Agents are self-contained units.** Each agent's system prompt, agent-specific tools, and (eventually) session state live inside `agents/<name>/`. A contributor can find everything about an agent in one place; `rm -rf agents/<name>/` is a clean delete.
4. **Shape absorbs future features without restructuring.** Skills, memory, per-agent permissions, per-agent session actions — all land as new optional fields on `AgentInfo` or new entries in the base layer, not structural rewrites.
5. **Headroom beyond the current two agents.** Planned next: Researcher, Knowledge Base. Long-tail: unknown. The shape must scale to ~5+ agents cleanly.

## Non-goals (today)

- User-defined agents (markdown-authored, config-file-authored, etc.). Dev-registered only for now.
- Subagents, task-tool delegation, mid-session agent switching.
- Full per-agent permission ruleset. The current permission dispatcher (see `docs/ARCHITECTURE.md` → Permission Dispatcher) covers vault scoping, per-agent zone confirmations, and reader's article-specific rules through the baseline + zones + overlay split — sufficient at 2–3 agents.
- Provider-pluggable or plugin-extensible agent frameworks.

## Key decisions

### D1 — Composition over inheritance

**Considered:** a `BaseAgent` class that `ReaderAgent`, `ExampleAgent`, etc. extend. This was the initial instinct (OO/CS default).

**Chosen:** a flat registry of plain data objects (`AgentInfo`), with shared behavior in a separate "base layer" applied at runtime by composer functions.

**Why:** every modern agent framework we surveyed (OpenCode, Claude Code, Cursor rules, Codex) moved away from inheritance. Agents diverge along multiple axes — prompt, tools, permissions, persona, session state — and a base class ends up mostly syntactic, fighting composition rather than enabling it. Flat-data + runtime-composition scales better: adding an agent is adding one row; shared behavior is applied at call time, not baked into a class tree.

**Consequence:** "base agent" in our terminology is a **layer**, not a class. The base layer isn't instantiable — it's a set of constants (`BASE_TOOLS`, `BASE_PREAMBLE`) plus composer functions (`composeTools`, `composeSystemPrompt`). The `AgentInfo` type lives there too because it's part of the base contract that every agent conforms to.

### D2 — Folder-per-agent layout

**Chosen:** each custom agent lives in `src/backend/agent/agents/<name>/` with its own `index.ts`, optional `instructions.ts`, and optional `tools/` subdirectory for **state-coupled** tools only. Agent-neutral tools live in the shared pool at `src/backend/agent/tools.ts` and are pulled into an agent's `extraTools` by import.

**Why:** self-contained units scale. `agents/reader/` is the canonical place for everything reader-specific; `agents/example/` likewise. When Researcher lands, it drops into `agents/researcher/` as a peer, touching nothing else. Deletion is `rm -rf`. Portability is copy-a-folder.

**Trade-off:** "where does a tool live?" has a categorical answer, not a positional one. If the tool is agent-neutral (no per-agent state), it goes in the shared pool (`agent/tools.ts`). If it's coupled to one agent's module-level state (e.g. a hypothetical `quote_active_article` that reads reader's in-memory active article), it goes under `agents/<agent>/tools/` and the agent's `index.ts` re-exports any state helpers the shell needs. The shell's boundary rule (`biome.json`) blocks deep imports of `agents/*/tools/*` to keep that contract honest.

### D3 — Base layer bundle

The base layer is split across three files in `backend/agent/` — `types.ts` (pure types), `compose.ts` (BASE_TOOLS, composers), `zones.ts` (zone-to-permission rule derivation). Together they export:

| Symbol | Purpose |
|---|---|
| `AgentInfo` (type) | The shape every agent conforms to |
| `AgentColorKey` (type) | Constrained string union for theme-accent keys |
| `BASE_TOOLS: AgentTool[]` | Foundation tools every agent receives (today: `[readTool]`, drawn from `backend/agent/tools.ts`) |
| `BASE_PREAMBLE: string` | Shared system-prompt prefix (today: `""`) |
| `composeTools(info)` | Returns `[...BASE_TOOLS, ...info.extraTools]` |
| `composeSystemPrompt(info, ctx)` | Prepends `BASE_PREAMBLE` to `info.buildInstructions(ctx)` when non-empty |

`backend/agent/tools.ts` is the **shared tool pool** — agent-neutral tools that any agent could plausibly want. Populated by calling `@mariozechner/pi-coding-agent`'s `createReadTool` / `createWriteTool` / `createEditTool` with `VAULT_DIR` as the `cwd`. Agents pick entries into `extraTools`; `BASE_TOOLS` references `readTool` from the same pool so every agent gets it.

**Classification rule**: a tool belongs to the shared pool if it's agent-neutral (no coupling to a specific agent's module-level state). State-coupled tools (none today) stay in `agents/<name>/tools/` and re-export any public helpers from the agent's `index.ts`, so the shell's agent-internal boundary rule (`biome.json`) can block deep imports.

**Why bundle these?** They are the "universal behavior" side of the system. Putting them together makes the extension point obvious: anything every agent should get goes here. Anything only one agent needs goes in that agent's folder.

### D4 — No opt-out on BASE_TOOLS

**Considered:** an `AgentInfo.foundationTools?: boolean` (default `true`) opt-out field. The Example agent would set it to `false` to stay truly tool-less.

**Chosen:** no opt-out. Every agent gets `BASE_TOOLS` unconditionally.

**Why:** simpler. Claiming an agent has "no tools" while its tool list contains one is worse than letting the Example agent have `read`. If "base" genuinely means "universal", the type should reflect that. Adding an opt-out lane now, speculatively, to support one agent's "minimal" aesthetic, would be the wrong trade-off — the Example prompt just drops the stale "You have no tools available" sentence.

**Consequence:** the Example agent has exactly the `BASE_TOOLS` set. It's still a useful smoke-test target ("agent with nothing extra"), just not "agent with zero tools".

### D5 — Ship mechanism, defer content

`BASE_PREAMBLE = ""` on ship. `BASE_TOOLS = [readTool]` only. No skills, no memory, no web search, no per-agent permission rulesets in the type.

**Why:** separates the redesign work (shape, composition, folder layout) from the content work (what should the preamble say? what tools belong in base? how do skills actually discover and load?). Shipping the mechanism first means future PRs are additive edits in one file, not structural rewrites.

This is explicit in the code and docs — we are not pretending the system is done. The base layer is a scaffold with the rooms clearly labeled. When content arrives, it fills those rooms without moving walls.

### D6 — AgentInfo is data, not a class

`AgentInfo` is a plain `interface`. Agents are literal objects conforming to it. No classes, no constructors, no `.extend()`, no mixins.

**Why:** data is easier to reason about, serialize, diff, and inspect. Every field is inspectable at a glance. There is no hidden state on an "instance". The registry is a simple array of literals.

**Trade-off:** we lose the language-level "override this method" ergonomic. We don't need it — agents are declarative specs, not behavioral objects. The composers handle the "runtime merge" job that inheritance would otherwise provide.

### D7 — Vault ≠ runtime state

Inkstone runtime state (config, sessions, OAuth credentials) lives under `~/.config/inkstone/`. Inkstone *vault-scoped configuration* (per-agent skills bundles and anything else an agent carries alongside its content) lives under `$VAULT/InkStone/`. The vault ($VAULT) itself remains user knowledge content.

**Why split this way:** the vault should be portable — a user can swap between vaults without carrying Inkstone's session history, OAuth tokens, or model selection with them. Runtime state is per-user-per-machine (via dotfile sync, typically). Putting it in the vault would couple machines. But **per-agent configuration travels with the vault it's scoped to** — a skill that teaches reader how to handle one specific vault's article format belongs alongside that vault. Putting skills under `~/.config/inkstone/` would mean swapping vaults silently loses them.

**Consequence:** skills (when they land) live under `$VAULT/InkStone/skills/<agent>/<skill>/SKILL.md`. Future per-agent configuration files follow the same `$VAULT/InkStone/` convention. `user.md` and `memory.md` (when they land) remain runtime state under `~/.config/inkstone/` — they're per-user identity, not per-vault content.

**Original framing** — "vault ≠ config" — is amended. The invariant that holds is **vault ≠ runtime state**. Vault-scoped configuration is legal and expected.

### D8 — Deferred features are pressure points, not APIs

**Chosen:** when we identify a feature that should land eventually (skills, memory, per-agent permissions, etc.), we document *the pressure that motivates it* and *the open questions at implementation time* — not a specific API shape, field name, or function signature.

**Why:** committing to a shape before the use case exists risks porting another system's design (OpenCode, Claude Code) instead of shaping around Inkstone's actual constraints. The shape arrives with the first real implementation — by then we know what pressure it's resolving, what adjacent concerns it must coexist with, and which of the candidate approaches actually fits.

This is D5 ("ship mechanism, defer content") extended to cover the future-work documentation surface, not just the shipped code. The "Anticipated pressure points" section below follows this discipline: each entry names the pressure + open questions, nothing more.

### D9 — Commands are first-class, declared per-agent, distinct from tools

**Chosen:** two orthogonal concepts at the agent layer.

- **Tools** (`AgentTool`) — model-invoked mid-turn. Already a first-class pi-agent-core concept. `read`, `edit`, `write`, etc. The agent decides when to invoke each one while executing a turn.
- **Commands** (`AgentCommand`) — user-invoked at turn boundaries. Declared on `AgentInfo.commands`. The TUI bridges each declared command into a single unified command registry so slash dispatch, palette, and keybinds share one surface. Examples: reader's `/article <filename>`, hypothetical KB agent's `/ingest`, `/query`, `/lint`.

**Why:** commands and tools answer different questions. Commands are "what does the user want the agent to do?" Tools are "what can the agent do to accomplish that?" Collapsing them (e.g. treating `/ingest` as a tool the model decides to invoke) loses the user-verb semantics; collapsing the other way (tools as commands) loses the mid-turn invocation pattern. Keeping them separate mirrors how Discord/Slack/OpenCode structure user input vs agent capabilities.

**Shape** (`src/backend/agent/types.ts`):

```ts
export interface AgentCommand {
  name: string;                   // verb without the leading slash
  description?: string;
  argHint?: string;               // "<filename>", "<folder>", "<question>"
  takesArgs?: boolean;            // requires non-empty args for typed slash dispatch
  execute(
    args: string,
    prompt: (text: string) => Promise<void>,
  ): void | Promise<void>;
}

export interface AgentInfo {
  // ... existing
  commands?: AgentCommand[];
}
```

`execute` receives a positional `prompt` function that kicks off an LLM turn. Commands typically compose a user message (e.g. reader's `/article` reads the article file and inlines path + content) and call `prompt(text)` to send it. The TUI's `BridgeAgentCommands` component (`src/tui/context/agent.tsx`) picks up `AgentInfo.commands` reactively on `store.currentAgent` and converts each entry into a `CommandOption` in the unified registry.

**System-prompt stability invariant.** `AgentInfo.buildInstructions()` must return a stable string for a given `AgentInfo`. pi-agent-core's `Agent` reads `state.systemPrompt` once per `prompt()` call via `createContextSnapshot()` and feeds the same bytes to every turn within that call; both Anthropic's `cache_control` block and Bedrock's `cachePoint` are pinned to the byte-exact system prefix, so any drift between turns invalidates the cache. `createSession` builds the prompt once; `Session.selectAgent` rebuilds it on an empty-session agent swap (see D13); `Session.clearSession` wipes messages without touching the prompt. Commands **must not** mutate state that `buildInstructions` reads. Dynamic per-turn context (date, cwd, memory recall, file snapshots, article content) goes into a user message via `prompt(text)`, not into the system prompt; reader's `/article` is the reference pattern. This matches pi-mono's expected usage (see `coding-agent`'s `_baseSystemPrompt` — rebuild only on tool-set change, resource reload, or extension override) and the cross-codebase consensus (claude-code's `prependUserContext`, openclaw's cache boundary, opencode's synthetic user parts, hermes's `ephemeral_system_prompt` escape hatch).

**Shell-level verbs** (`/clear`) live directly as `CommandOption` entries in `Layout()` (`src/tui/app.tsx`), closing over the TUI wrapper's `clearSession`. They don't go through `AgentCommand` because there's no agent-owned state involved — a shell action registered with `slash: { name: "clear" }` is the simpler expression.

**Dispatch precedence**: agent-declared commands override shell-level commands on slash-name collision. Mechanism: `AgentProvider` mounts inside `CommandProvider`, and `command.register` prepends to its internal list, so agent-bridge entries sit ahead of `Layout`'s entries. First-match wins. Intentional — an agent can redefine `/clear` if its semantics differ (none do today).

**Why `prompt` is positional, not wrapped in a context object**: an earlier iteration of D9 introduced an `AgentCommandContext { prompt, setActiveArticle }` object, justified as "widening has to be an explicit decision per capability." In practice only `prompt` was used universally, and `setActiveArticle` was reader-shaped leakage on a supposedly generic type. When reader went stateless (see the reader statelessness refactor in `docs/TODO.md`), `setActiveArticle` disappeared entirely. The remaining one-field context had no justification for existing, so the context object was replaced with a positional `prompt` argument. If a second capability ever does arrive, revisit — but don't re-introduce the wrapper prematurely; the positional-function shape is the minimum-viable surface. D8's "pressure point, not API" applies.

**What this resolves**: the "Reader-specific vocabulary leaks onto AgentActions" pressure point. `loadArticle` is gone from `AgentActions`; it's now a reader command. `buildInstructions` is nullary — no `AgentBuildContext` carrying reader-shaped fields. D9's original design introduced `runAgentCommand` + `canRunAgentCommand` on `AgentActions` plus a wider `CommandContext` with `clearSession` and `abort` — all of those have since been removed in favor of the bridge pattern (see "Unified command registry" below). The originally-proposed `refreshSystemPrompt` hook was dropped when the shell briefly moved to per-turn prompt rebuilding, and then the per-turn rebuild itself was dropped in favor of the stability invariant documented above. The `AgentCommandContext` wrapper was dropped when reader's statelessness refactor made it one-field-only.

**Unified command registry** (SLASH-COMMANDS.md Path A): the dialog-opening commands (`/models`, `/themes`, `/connect`, `/agents`, `/effort`) and agent-declared commands (`/article`) share the same TUI-side `CommandOption` type. `AgentCommand` holds only data (no `onSelect`); the TUI's bridge owns the adapter. Agent code stays layer-correct (declares plain data); TUI code owns presentation (closes over `DialogContext` and `AgentActions` as needed).

### D10 — Tool implementations come from pi-coding-agent

**Considered:** own Inkstone-specific `readFileTool` / `editFileTool` / `writeFileTool` forever (the pre-refactor state — 4 custom tools, one per file).

**Chosen:** delegate to `@mariozechner/pi-coding-agent`'s factory functions (`createReadTool`, `createWriteTool`, `createEditTool`) called with `VAULT_DIR` as the `cwd`. Inkstone's `backend/agent/tools.ts` is a thin wrapper that instantiates them once at module load and exports them for the base layer + agent `extraTools` to consume.

**Why:** Inkstone was re-implementing the generic file-tool capability. pi-coding-agent's versions cover the same vocabulary with meaningfully more rigor — offset/limit reads, image-file support, multi-edit in a single `edit` call, per-path mutation queueing to serialize concurrent writes, and truncation with actionable continuation hints. Owning parallel implementations is bookkeeping we don't need; upstream drift is the price.

**Trade-offs accepted:**

- **pi-tui transitive dep.** pi-coding-agent's tool source files import `@mariozechner/pi-tui` at module scope for their `renderCall` / `renderResult` hooks. `wrapToolDefinition` strips those hooks when the tool is handed to pi-agent-core, so pi-tui never runs in Inkstone — but it IS loaded at module-resolve time. Inert at runtime, a few hundred KB of JS that does nothing. Acceptable cost for dropping 4 hand-maintained tool files.
- **pi-agent-core version bump** from `^0.67.68` to `^0.69` (pi-coding-agent@0.69 requires it). The public type surface Inkstone uses (`Agent`, `AgentTool`, `AgentEvent`, `BeforeToolCallContext`, `ThinkingLevel`, `AssistantMessageEvent`) is unchanged between the two versions.
- **Prompt-cache bust** (one-time). Tool names changed (`read_file` → `read`, etc.) and count dropped from 4 to 3 for reader (no more `quote_article`). Anthropic/Bedrock/OpenAI prompt caches keyed on the byte-exact tools prefix invalidate once on first turn after deploy. Unavoidable with a rename.
- **Guard must mirror pi-coding-agent's path expansion.** pi-coding-agent expands `~` / `~/` against `$HOME` and strips a leading `@`. The permission dispatcher inlines the same subset (`backend/agent/permissions.ts:resolvePath`); otherwise `startsWith(VAULT_DIR)` could pass on a literal `~/foo` while the tool writes to `$HOME/foo`. pi-coding-agent doesn't re-export those helpers from its package index, so the subset is inlined rather than imported.

**Quote article dropped.** `quote_article` was a paragraph-substring search over the currently-open article — in practice, the LLM can achieve the same thing with `read` + its own context window, so the tool was a hole-filler rather than genuine capability. Removed. Reader's instructions now tell the model to read the article and quote from its context.

### D11 — Declarative permission dispatcher

**Considered:** keep the procedural guard in `guard.ts` that pattern-matches tool names (`read` / `edit` / `write`) and encodes reader's article rule inline, with `_articlePath` injected into `ctx.args` as a side channel so the guard can see the active article.

**Chosen:** a single `beforeToolCall` entry point delegates to `dispatchBeforeToolCall` in `backend/agent/permissions.ts`. Rules are declarative data (array of tagged objects). Tools register baseline rules at module load; agents expose optional `getPermissions?(): AgentOverlay` for agent-scoped additions. See `docs/ARCHITECTURE.md` Permission Dispatcher.

**Why:** the procedural guard bundled reader-specific knowledge into the shell and forced the `_articlePath` hack. Splitting into (a) per-tool baselines + (b) per-agent overlay produces:
- **DRY**: VAULT_DIR sandbox declared once on each tool, shared by every agent.
- **Local ownership**: reader's article rule lives in reader's own folder (`getPermissions`), not in shell code.
- **No side channels**: overlay rules close over module state directly; no `ctx.args` mutation.
- **Extension point**: future agents plug in additional rules without touching shell, tools, or reader.

**Trade-offs accepted:**

- **`getPermissions` is a function.** Pure data is the goal; rule *production* remains a factory callback so state-dependent values (reader's article path) can be inlined fresh each call. The rules themselves are still pure data — only the producer is a function. A push model (reader calls `setPermissions(rules)` on every state change) was considered but adds coordination cost for no readability gain.
- **Speculative rule kinds.** The rule-kind union is sized to current needs + one. Today reader uses `blockInsideDirs` and `frontmatterOnlyInDirs`; both originated as reader-specific shapes but are generic enough that a future agent with read-only directories or frontmatter-only zones can reuse them. Earlier per-file variants (`blockPath`, `frontmatterOnlyFor`) existed during the active-article phase and were deleted when reader went stateless — the union is now smaller than it was, not larger.
- **No enforcement that every tool has a baseline.** A tool registered in `composeTools` without a matching `registerBaseline(tool.name, ...)` call runs unsandboxed. Convention suffices today (fixed tool set); enforcement (e.g. throw at compose time) can be added when plugin tools arrive.

**Function escape hatch not built.** A rule kind whose predicate is `(params) => boolean` was considered but deferred — every current need fits a named rule kind. Add if a real case doesn't.

**What this resolves:** the "shell knows reader's business" pressure point. The dispatcher has no reader knowledge. Session restore stops caring about `_articlePath`. A future Researcher or Knowledge-Base agent declares its own overlay (or doesn't) without modifying the dispatcher or the shell.

### D12 — Zones: declarative workspace

**Chosen:** each agent declares a `zones: AgentZone[]` field on `AgentInfo`. A zone is `{ path: string, write: "auto" | "confirm" }` where `path` is vault-relative. Zones feed two composers from one declaration:

- `composeZonesOverlay(info)` produces the matching D11 permission rules (`confirmDirs` for `confirm` zones; `auto` emits nothing — the baseline already permits writes inside the vault). Merged with `AgentInfo.getPermissions?.()` by `composeOverlay`.
- `composeSystemPrompt(info)` prepends a `<your workspace>` block at the top of the system prompt listing each zone's path and policy so the LLM knows where it may write.

**Why:** the prior shape had two independent declarations of the same rule — reader's workspace was described in prose inside `buildInstructions` *and* enforced by rules inside `getPermissions`. They had to agree by hand. With zones, the LLM's stated workspace and the dispatcher's enforced workspace derive from the same data; drift between prompt and dispatcher is impossible.

**Merge order: custom rules first, then zones.** `composeOverlay(info) = info.getPermissions?.() ⊕ composeZonesOverlay(info)` (custom first). The dispatcher is first-block-wins, so the stricter rule must come first to short-circuit before the looser one fires. Concretely: reader's custom `blockInsideDirs` rejects `write` against any article outright; the zone's `confirmDirs` on the same Articles path would otherwise prompt for a write that's guaranteed to fail. Custom-first lets the block win without a wasted prompt. This is the opposite of the "baseline first, tighten second" intuition that governed D11's tool baselines; D12 flips it because zones are *lenient* directory policies layered *over* stricter file-level custom rules, not under.

**Tool baselines trimmed to the hard vault boundary.** Before D12, the `write`/`edit` tool baselines carried `confirmDirs: [NOTES_DIR, SCRAPS_DIR]` as a global guardrail. That produced double-confirms once zones also covered Notes/Scraps. Fix: directory-level confirmation moved entirely to zones. The baseline still owns `insideDirs: [VAULT_DIR]` — the hard boundary every agent must respect — but no directory-level confirmation. An agent with empty zones (example) gets no confirmation on vault-internal writes, which is what "empty workspace" means.

**Read stays vault-wide.** Zones constrain writes only. Any agent can read anywhere in the vault (subject to the tool baseline `insideDirs: [VAULT_DIR]`). The ambient-context pattern — agent reads `090 SYSTEM/` or similar on demand to discover workflows, schemas, templates — depends on vault-wide read. Zones are the right line because "where I work" ≠ "where I look up references."

**`getPermissions` stays as an escape hatch.** Zones are the declarative baseline; `getPermissions` handles rules zones can't express — today's example is reader's `frontmatterOnlyInDirs` rule on the Articles zone. Directory-scoped but not a zone policy (it constrains edit *shape*, not just whether writes are allowed). The escape hatch being function-shaped (not data) is the same D8 trade-off as D11: rule *production* can stay dynamic while rule *data* stays pure.

**Path matching stays `startsWith`-based.** Zones are folder paths today. Composer uses `node:path.join(VAULT_DIR, zone.path)` so leading/trailing slashes normalize; absolute zone paths throw at compose time. Glob support (for targeting a specific file inside a zone, for example) is a deferred decision pending a real use case.

**Policy verbs are phrased, not named, in the prompt.** `auto` renders as "write freely", `confirm` as "confirm before write". The LLM reasons about consequences, not internal labels.

**`deny` zone policy not yet shipped.** A third policy for read-only zones was considered. The matching rule kind (`blockInsideDirs`) now exists as a standalone primitive — reader uses it via `getPermissions` to make the Articles zone read-only-except-frontmatter. Adding `write: "deny"` on `AgentZone` that maps to `blockInsideDirs` is a small ergonomics win for agents that want declarative read-only zones. Deferred per D8 until a real agent asks.

**Consequence:** adding a zone-declaring agent is a data-only change. Reader's workspace paragraphs in the instruction prose are gone — the composer renders them from `zones` — so a new agent copy-pasting reader's shape gets the right prompt block + the right permission rules from a single field.

**Rejected alternative:** per-zone *read* policy. "Read is always vault-wide" was a user call — agents need broad reads for cross-zone references and ambient context. An agent that wants to read outside its write zone is the normal case, not the exception. If a future agent needs a read fence (e.g. privacy-scoped assistant that must not see financial notes), extend the type then.

**Open pressure point**: all hard-coded vault paths in code (zone declarations, `constants.ts`) should eventually move to user configuration so non-default vault layouts work without code changes. Tracked in TODO.md.

### D13 — Session-agent binding

**Chosen:** one agent per session; agent fixed for the session's lifetime. The `Session` returned from `createSession({ agentName, onEvent })` is bound to one agent name; `selectAgent(name)` is legal only when the session has zero messages and throws otherwise. Model is orthogonal — mid-session `setModel` / `setThinkingLevel` stay supported.

**Why:**

- **Cache stability.** Swapping agent mid-session rewrites `systemPrompt` + `tools`, both of which Anthropic's `cache_control` and Bedrock's `cachePoint` pin as the byte-exact prefix. Every swap would invalidate the cache for the rest of the conversation. See D9's stability invariant.
- **Bubble provenance.** Each assistant bubble is stamped with the agent that produced it (`displayMessage.agentName`). With a mid-session swap, earlier bubbles claim the new agent's name unless we reach back and re-stamp, which duplicates bookkeeping OpenCode needed (per-message `agent` on user bubbles, tool-result routing). Inkstone's "one agent per session" model dodges this entirely.
- **Permission model clarity.** Zones and custom rules are agent-scoped. A mid-session swap means previously-sent tool calls ran under one set of rules and future ones run under another — surprising if the user expects "the session's policy" to be stable.

**UI consequence:** Tab / Shift+Tab, the Agents dialog, and the palette entry are all visible only on the empty open page (`store.messages.length === 0`). Reaching `selectAgent` with messages present is a bug, so the backend throws. The UI gates prevent users from seeing the error in normal use.

**Rejected alternative — swap always allowed, rebuild on demand:** matches OpenCode's model. We rejected it for the three reasons above; Inkstone trades the extra capability for a simpler model (per-bubble agent stamps are always correct; permission rules never retroactively change; cache stays warm).

**Rejected alternative — tear down + reconstruct the Agent on selection:** the factory pattern would let `selectAgent` drop the Agent instance and rebuild. We reuse the instance instead because (a) the Agent carries the event subscription that drives the TUI store, (b) nothing in the selection changes mid-turn so no state needs to be discarded, and (c) the in-place `state.systemPrompt` / `state.tools` rewrite is the smaller change. The factory is still the right shape for boot construction and future multi-session scenarios.

**Consequence for future `/resume`:** a restored session knows its agent (from the `sessions.agent` column). `createSession({ agentName })` takes an explicit agent name, so `/resume` passes it through and hydrates under the correct agent — no mid-session swap, no reconciliation, no ordering hole.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Class hierarchy (`BaseAgent` → `ReaderAgent`) | See D1. Industry pattern is flat + composition; inheritance fights divergence. |
| OpenCode-style permission ruleset per agent | Overkill at 2–3 agents. The current permission dispatcher (baseline + zones + overlay) covers vault scoping + per-agent confirmations. Revisit when an agent needs truly different tool access from its peers. |
| Global tool registry + per-agent allow/deny rules | Same reasoning as above — pattern-driven permissions are the power answer; we don't have the demand yet. |
| User-defined agents via `.md` files | Out of scope for the dev-facing redesign. Revisit if an end-user path becomes relevant. |
| Eager-load all skills at session boot | When skills land, we'll use lazy loading (summaries in the system prompt, full bodies fetched on demand) — OpenCode's pattern. Eager loading inflates tokens on every turn even when a skill is never used. |
| Skill bundles colocated under `agents/<name>/skills/` | User direction amended in D7: skills live under `$VAULT/InkStone/skills/<agent>/<skill>/SKILL.md`, per-agent (not shared). |
| `memory.md` / `user.md` inside the vault (e.g. `$VAULT/.inkstone/`) | D7 amended: vault-scoped configuration goes under `$VAULT/InkStone/`, but memory files remain runtime state under `~/.config/inkstone/` (per-user identity, not per-vault content). |
| Session.json colocated with vault | Same as above. |
| Subagent delegation via a `task` tool (OpenCode pattern) | Single agent per session is the Inkstone constraint today. Revisit if a concrete use case (e.g. Reader delegating a targeted search to Researcher) emerges. |
| `foundationTools?: boolean` opt-out on `AgentInfo` | See D4. Coarse opt-out speculative for one agent's aesthetic. |

## Anticipated pressure points

These are the points where Inkstone's usage is likely to push next. Per D8, each is documented as *pressure + open questions*, not as a pre-committed API. The first real implementation drives the shape.

### Skills (deferred)

See [`docs/SKILLS.md`](./SKILLS.md) for the full exploration — known shape, open questions at implementation time, and when to revisit.

### Memory files (deferred — read + write paths)

See [`docs/MEMORY.md`](./MEMORY.md) for the full exploration — read-path known shape, write-path design problem, and when to revisit each.

### Reader-specific vocabulary leaks onto AgentActions (resolved via D9 + statelessness refactor)

`AgentActions.loadArticle` was reader-shaped vocabulary on a "generic" action surface. `activeArticle` lived as module-level state in `backend/agent/index.ts`. `buildInstructions(ctx)` took an `AgentBuildContext` with a reader-shaped `activeArticle` field every agent received.

All three resolved via D9, then further simplified by the reader statelessness refactor:

- **Verb**: `AgentActions.loadArticle` is gone. Reader declares `articleCommand: AgentCommand` in `agents/reader/index.ts`. Slash dispatch goes through the TUI's `BridgeAgentCommands` bridge.
- **State**: `activeArticle` module state is **gone entirely**. Reader's `/article` command reads the file at invocation time and inlines path + content into the opening user message. No cross-turn state survives.
- **Context**: `AgentBuildContext` was dropped early (D9). `AgentCommandContext` followed later — with reader's state gone, the only remaining capability (`prompt`) became a positional argument on `AgentCommand.execute`. `AgentInfo.buildInstructions()` is nullary; each agent reads whatever per-turn context it needs directly (no agent does today).

No residual leakage. `clearSession` no longer touches reader state (there isn't any to touch). The anticipated `onSessionClear?()` lifecycle hook that would have abstracted the reset across multiple agents is also unneeded — absent the state, there's nothing to hook onto. When the next agent arrives with genuine cross-turn state, revisit then.

### BASE_TOOLS mutability (resolved)

`BASE_TOOLS` is exported as `readonly AgentTool<any>[]` and wrapped in `Object.freeze`. External code cannot `.push(...)` or swap indices; `composeTools` already returns a fresh array via spread, so the "`compose.ts` owns what's in `BASE_TOOLS`" invariant is now enforced at the language level.

A `registerBaseTool(tool)` registration function would be the plugin-era answer if multi-module contribution ever becomes a real requirement, but Inkstone has no plugin model today. Don't design it speculatively.

### Web search (candidate, scope TBD)

Likely useful, not obviously universal. Researcher almost certainly wants it. Reader may or may not. Knowledge Base may want constrained ingestion search rather than open web search. Cost, privacy, provider selection, and per-agent permission all come into play.

Decide whether a web-search tool lives in `BASE_TOOLS` or per-agent `extraTools` when Researcher is actually implemented. "Universal" was a premature claim.

### Per-agent permissions (probably never)

No concrete case exists yet where two Inkstone agents need different tool access under the same set of tools. The permission dispatcher (baseline + zones + overlay) covers vault scoping uniformly and per-agent confirmations via zones, and that may continue to suffice.

If a real split emerges (e.g. Researcher can read outside `ARTICLES_DIR` but Reader cannot), design the ruleset against Inkstone's actual tools and guard shape — don't port OpenCode's `Permission.Ruleset`. Porting without a driving case would pre-commit to pattern matching, `ask/allow/deny` tri-state, and rule-merge semantics that Inkstone has shown no need for.

## Terminology

- **Agent** — the persona the user is chatting with. `readerAgent` / `exampleAgent` / future `researcherAgent`. A literal conforming to `AgentInfo`.
- **Base agent** — the shared foundation layer, conceptually. Not an instance, not a class. Everything exported from `backend/agent/{types,compose,zones}.ts`, with tool implementations pulled in from `backend/agent/tools.ts`.
- **Custom agent** — any agent under `backend/agent/agents/`. Reader and Example today.
- **extraTools** — tools specific to a custom agent, composed with `BASE_TOOLS` at runtime by `composeTools`.
- **BASE_TOOLS / BASE_PREAMBLE / composeTools / composeSystemPrompt** — the four canonical exports that define the base layer's public contract.
- **Foundation tools** — informal synonym for `BASE_TOOLS`. Used interchangeably in discussion; code uses `BASE_TOOLS`.
- **Command** (`AgentCommand`) — a user-invoked verb declared on `AgentInfo.commands` or in `BUILTIN_COMMANDS`. `/article`, `/clear`. Distinct from a **tool**: commands are user-facing, invoked at turn boundaries via `runAgentCommand`; tools are LLM-invoked mid-turn. See D9.
- **Tool** (`AgentTool`) — a pi-agent-core capability the LLM invokes during a turn. `read`, `write`, `edit`. Distinct from a **command**.
- **Skills** (future) — self-contained knowledge bundles (SKILL.md files) loaded on demand into conversations. See `docs/SKILLS.md`.
- **Memory files** (future) — `user.md` + `memory.md` under `~/.config/inkstone/`, inlined into the system prompt at compose time. See `docs/MEMORY.md`.
- **Pressure point** — a place where current code shape is known to strain under anticipated future work, documented with the pressure + open questions but without a pre-committed API. See D8.

## References

- Implementation reference — `docs/ARCHITECTURE.md` → "Agent Registry" section.
- Active / future work — `docs/TODO.md` → "Future Work (Post-MVP)".
- OpenCode comparison — `../opencode/packages/opencode/src/agent/agent.ts` (flat registry + permission ruleset for per-agent tool scoping).
- pi-agent-core API — `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts`.
