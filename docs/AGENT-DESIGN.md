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
- Full per-agent permission ruleset. The existing `guard.ts` (vault scoping + confirmations) is sufficient at 2–3 agents.
- Provider-pluggable or plugin-extensible agent frameworks.

## Key decisions

### D1 — Composition over inheritance

**Considered:** a `BaseAgent` class that `ReaderAgent`, `ExampleAgent`, etc. extend. This was the initial instinct (OO/CS default).

**Chosen:** a flat registry of plain data objects (`AgentInfo`), with shared behavior in a separate "base layer" applied at runtime by composer functions.

**Why:** every modern agent framework we surveyed (OpenCode, Claude Code, Cursor rules, Codex) moved away from inheritance. Agents diverge along multiple axes — prompt, tools, permissions, persona, session state — and a base class ends up mostly syntactic, fighting composition rather than enabling it. Flat-data + runtime-composition scales better: adding an agent is adding one row; shared behavior is applied at call time, not baked into a class tree.

**Consequence:** "base agent" in our terminology is a **layer**, not a class. The base layer isn't instantiable — it's a set of constants (`BASE_TOOLS`, `BASE_PREAMBLE`) plus composer functions (`composeTools`, `composeSystemPrompt`). The `AgentInfo` type lives there too because it's part of the base contract that every agent conforms to.

### D2 — Folder-per-agent layout

**Chosen:** each custom agent lives in `src/backend/agent/agents/<name>/` with its own `index.ts`, optional `instructions.ts`, and optional `tools/` subdirectory. Tools that only one agent uses are colocated with that agent, not pooled in a central tools directory.

**Why:** self-contained units scale. `agents/reader/` is the canonical place for everything reader-related; `agents/example/` likewise. When Researcher lands, it drops into `agents/researcher/` as a peer, touching nothing else. Deletion is `rm -rf`. Portability is copy-a-folder.

**Trade-off:** tools that are genuinely shared (today just `read_file`) live in `base/tools/`, which is a different folder from where most tools live. That's by design — shared ≠ agent-specific — but it means "where does a tool live?" has a categorical answer ("base" vs "specific agent's folder"), not a positional one.

### D3 — Base layer bundle

The base layer (`backend/agent/base/index.ts`) exports:

| Symbol | Purpose |
|---|---|
| `AgentInfo` (type) | The shape every agent conforms to |
| `AgentColorKey` (type) | Constrained string union for theme-accent keys |
| `BASE_TOOLS: AgentTool[]` | Foundation tools every agent receives (today: `[readFileTool]`) |
| `BASE_PREAMBLE: string` | Shared system-prompt prefix (today: `""`) |
| `composeTools(info)` | Returns `[...BASE_TOOLS, ...info.extraTools]` |
| `composeSystemPrompt(info, ctx)` | Prepends `BASE_PREAMBLE` to `info.buildInstructions(ctx)` when non-empty |

**Why bundle these?** They are the "universal behavior" side of the system. Putting them together makes the extension point obvious: anything every agent should get goes here. Anything only one agent needs goes in that agent's folder.

### D4 — No opt-out on BASE_TOOLS

**Considered:** an `AgentInfo.foundationTools?: boolean` (default `true`) opt-out field. The Example agent would set it to `false` to stay truly tool-less.

**Chosen:** no opt-out. Every agent gets `BASE_TOOLS` unconditionally.

**Why:** simpler. Claiming an agent has "no tools" while its tool list contains one is worse than letting the Example agent have `read_file`. If "base" genuinely means "universal", the type should reflect that. Adding an opt-out lane now, speculatively, to support one agent's "minimal" aesthetic, would be the wrong trade-off — the Example prompt just drops the stale "You have no tools available" sentence.

**Consequence:** the Example agent has exactly the `BASE_TOOLS` set. It's still a useful smoke-test target ("agent with nothing extra"), just not "agent with zero tools".

### D5 — Ship mechanism, defer content

`BASE_PREAMBLE = ""` on ship. `BASE_TOOLS = [readFileTool]` only. No skills, no memory, no web search, no per-agent permission rulesets in the type.

**Why:** separates the redesign work (shape, composition, folder layout) from the content work (what should the preamble say? what tools belong in base? how do skills actually discover and load?). Shipping the mechanism first means future PRs are additive edits in one file, not structural rewrites.

This is explicit in the code and docs — we are not pretending the system is done. The base layer is a scaffold with the rooms clearly labeled. When content arrives, it fills those rooms without moving walls.

### D6 — AgentInfo is data, not a class

`AgentInfo` is a plain `interface`. Agents are literal objects conforming to it. No classes, no constructors, no `.extend()`, no mixins.

**Why:** data is easier to reason about, serialize, diff, and inspect. Every field is inspectable at a glance. There is no hidden state on an "instance". The registry is a simple array of literals.

**Trade-off:** we lose the language-level "override this method" ergonomic. We don't need it — agents are declarative specs, not behavioral objects. The composers handle the "runtime merge" job that inheritance would otherwise provide.

### D7 — Vault ≠ config

All Inkstone runtime state (config, session, future memory files, future skill bundles) lives under `~/.config/inkstone/`. The vault (`$VAULT`) is user knowledge content only.

**Why:** separation of concerns. The vault should be portable — a user can swap between vaults without carrying Inkstone's state with them. Conversely, Inkstone's state is per-user across machines (via dotfile sync), not per-vault. Bleeding config into the vault would couple them.

**Consequence:** future `memory.md`, `user.md`, and skill bundles live under `~/.config/inkstone/`, not inside the vault. A later pass may introduce per-vault overrides that layer on top, but that's an extension — not the default shape.

### D8 — Deferred features are pressure points, not APIs

**Chosen:** when we identify a feature that should land eventually (skills, memory, per-agent permissions, etc.), we document *the pressure that motivates it* and *the open questions at implementation time* — not a specific API shape, field name, or function signature.

**Why:** committing to a shape before the use case exists risks porting another system's design (OpenCode, Claude Code) instead of shaping around Inkstone's actual constraints. The shape arrives with the first real implementation — by then we know what pressure it's resolving, what adjacent concerns it must coexist with, and which of the candidate approaches actually fits.

This is D5 ("ship mechanism, defer content") extended to cover the future-work documentation surface, not just the shipped code. The "Anticipated pressure points" section below follows this discipline: each entry names the pressure + open questions, nothing more.

### D9 — Commands are first-class, declared per-agent, distinct from tools

**Chosen:** two orthogonal concepts at the agent layer.

- **Tools** (`AgentTool`) — model-invoked mid-turn. Already a first-class pi-agent-core concept. `read_file`, `edit_file`, `quote_article`, etc. The agent decides when to invoke each one while executing a turn.
- **Commands** (`AgentCommand`) — user-invoked at turn boundaries. Declared on `AgentInfo.commands`. The TUI bridges each declared command into a single unified command registry so slash dispatch, palette, and keybinds share one surface. Examples: reader's `/article <filename>`, hypothetical KB agent's `/ingest`, `/query`, `/lint`.

**Why:** commands and tools answer different questions. Commands are "what does the user want the agent to do?" Tools are "what can the agent do to accomplish that?" Collapsing them (e.g. treating `/ingest` as a tool the model decides to invoke) loses the user-verb semantics; collapsing the other way (tools as commands) loses the mid-turn invocation pattern. Keeping them separate mirrors how Discord/Slack/OpenCode structure user input vs agent capabilities.

**Shape**:

```ts
// src/backend/agent/base/index.ts — narrow context with only
// capabilities actual commands use today.
export interface AgentCommandContext {
  prompt(text: string): Promise<void>;
  refreshSystemPrompt(): void;
}

export interface AgentCommand {
  name: string;                   // verb without the leading slash
  description?: string;
  argHint?: string;               // "<filename>", "<folder>", "<question>"
  takesArgs?: boolean;            // requires non-empty args for typed slash dispatch
  execute(args: string, ctx: AgentCommandContext): void | Promise<void>;
}

export interface AgentInfo {
  // ... existing
  commands?: AgentCommand[];
}
```

`execute` can mutate agent-owned state, call `ctx.prompt(template)` to kick off an LLM turn with a command-specific template, and/or call `ctx.refreshSystemPrompt()` after state changes. The TUI's `BridgeAgentCommands` component (`src/tui/context/agent.tsx`) picks up `AgentInfo.commands` reactively on `store.currentAgent` and converts each entry into a `CommandOption` in the unified registry. `onSelect` closes over the narrow `AgentCommandContext` built from `wrappedActions.prompt` / `wrappedActions.refreshSystemPrompt`, so command side effects share the same Solid-store and persistence path as direct UI actions.

**Shell-level verbs** (`/clear`) live directly as `CommandOption` entries in `Layout()` (`src/tui/app.tsx`), closing over `AgentActions.clearSession`. They don't go through `AgentCommand` because there's no agent-owned state involved — a shell action registered with `slash: { name: "clear" }` is the simpler expression. This is what removed the `clearSession` trampoline that used to live on `CommandContext`.

**Dispatch precedence**: agent-declared commands override shell-level commands on slash-name collision. Mechanism: `AgentProvider` mounts inside `CommandProvider`, and `command.register` prepends to its internal list, so agent-bridge entries sit ahead of `Layout`'s entries. First-match wins. Intentional — an agent can redefine `/clear` if its semantics differ (none do today).

**Why the context is narrow**: `AgentCommandContext` exposes only `prompt` and `refreshSystemPrompt`. Anything a shell knows how to do — clearing the session, switching agent/model, opening a dialog — is not a command concern and is deliberately absent. Shell actions register their own `CommandOption` entries; commands don't invoke them. Widening the context has to be an explicit decision per capability.

**What this resolves**: the "Reader-specific vocabulary leaks onto AgentActions" pressure point. `loadArticle` is gone from `AgentActions`; it's now a reader command with state owned by the reader module. `buildInstructions` is nullary — no `AgentBuildContext` carrying reader-shaped fields. D9's original design introduced `runAgentCommand` + `canRunAgentCommand` on `AgentActions` plus a wider `CommandContext` with `clearSession` and `abort` — both have since been removed (see "Unified command registry" below) in favor of the bridge pattern.

**Unified command registry** (SLASH-COMMANDS.md Path A): the dialog-opening commands (`/models`, `/themes`, `/connect`, `/agents`, `/effort`) and agent-declared commands (`/article`) now share the same TUI-side `CommandOption` type. The previous "Non-goal" here (dialog-openers stay palette-only because `DialogContext` can't cross the layer boundary) is resolved: `DialogContext` never crosses the boundary, because `AgentCommand` no longer holds an `onSelect` — the TUI's bridge owns the adapter. Agent code stays layer-correct (declares plain data); TUI code owns presentation (closes over `DialogContext` and `AgentActions` as needed).

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Class hierarchy (`BaseAgent` → `ReaderAgent`) | See D1. Industry pattern is flat + composition; inheritance fights divergence. |
| OpenCode-style permission ruleset per agent | Overkill at 2–3 agents. Today's `guard.ts` covers vault scoping + confirmations. Revisit when an agent needs truly different tool access from its peers. |
| Global tool registry + per-agent allow/deny rules | Same reasoning as above — pattern-driven permissions are the power answer; we don't have the demand yet. |
| User-defined agents via `.md` files | Out of scope for the dev-facing redesign. Revisit if an end-user path becomes relevant. |
| Eager-load all skills at session boot | When skills land, we'll use lazy loading (summaries in the system prompt, full bodies fetched on demand) — OpenCode's pattern. Eager loading inflates tokens on every turn even when a skill is never used. |
| Skill bundles colocated under `agents/<name>/skills/` | User direction: skills are agent-created or global, not colocated. Will live under `~/.config/inkstone/skills/`. |
| `memory.md` / `user.md` inside the vault (e.g. `$VAULT/.inkstone/`) | Rejected in design discussion — see D7. |
| Session.json colocated with vault | Same as above. |
| Subagent delegation via a `task` tool (OpenCode pattern) | Single agent per session is the Inkstone constraint today. Revisit if a concrete use case (e.g. Reader delegating a targeted search to Researcher) emerges. |
| `foundationTools?: boolean` opt-out on `AgentInfo` | See D4. Coarse opt-out speculative for one agent's aesthetic. |

## Anticipated pressure points

These are the points where Inkstone's usage is likely to push next. Per D8, each is documented as *pressure + open questions*, not as a pre-committed API. The first real implementation drives the shape.

### Skills (deferred)

See [`docs/SKILLS.md`](./SKILLS.md) for the full exploration — known shape, open questions at implementation time, and when to revisit.

### Memory files (deferred — read + write paths)

See [`docs/MEMORY.md`](./MEMORY.md) for the full exploration — read-path known shape, write-path design problem, and when to revisit each.

### Reader-specific vocabulary leaks onto AgentActions (resolved via D9)

`AgentActions.loadArticle` was reader-shaped vocabulary on a "generic" action surface. `activeArticle` lived as module-level state in `backend/agent/index.ts`. `buildInstructions(ctx)` took an `AgentBuildContext` with a reader-shaped `activeArticle` field every agent received.

All three resolved via D9:

- **Verb**: `AgentActions.loadArticle` is gone. Reader declares `articleCommand: AgentCommand` in `agents/reader/index.ts`. Shell dispatches via `AgentActions.runAgentCommand("article", filename)`.
- **State**: `activeArticle` moved to `agents/reader/index.ts` as module-level state. Reader exposes `getActiveArticle()` / `setActiveArticle(id)` for the shell's `beforeToolCall` guard injection and session restore.
- **Context**: `AgentBuildContext` dropped. `AgentInfo.buildInstructions()` is nullary — each agent reads its own state directly.

Residual: the shell's `clearSession()` calls `setActiveArticle(null)` to reset reader's state. Minimal reader-knowledge leak acceptable for now; when a second agent gains per-agent session state, introduce an `onSessionClear?()` lifecycle hook on `AgentInfo` that the shell iterates.

### BASE_TOOLS mutability (resolved)

`BASE_TOOLS` is exported as `readonly AgentTool<any>[]` and wrapped in `Object.freeze`. External code cannot `.push(...)` or swap indices; `composeTools` already returns a fresh array via spread, so the "`base/` owns what's in `BASE_TOOLS`" invariant is now enforced at the language level.

A `registerBaseTool(tool)` registration function would be the plugin-era answer if multi-module contribution ever becomes a real requirement, but Inkstone has no plugin model today. Don't design it speculatively.

### Web search (candidate, scope TBD)

Likely useful, not obviously universal. Researcher almost certainly wants it. Reader may or may not. Knowledge Base may want constrained ingestion search rather than open web search. Cost, privacy, provider selection, and per-agent permission all come into play.

Decide whether a web-search tool lives in `BASE_TOOLS` or per-agent `extraTools` when Researcher is actually implemented. "Universal" was a premature claim.

### Per-agent permissions (probably never)

No concrete case exists yet where two Inkstone agents need different tool access under the same set of tools. `guard.ts` covers vault scoping and confirmations uniformly, and that may continue to suffice.

If a real split emerges (e.g. Researcher can read outside `ARTICLES_DIR` but Reader cannot), design the ruleset against Inkstone's actual tools and guard shape — don't port OpenCode's `Permission.Ruleset`. Porting without a driving case would pre-commit to pattern matching, `ask/allow/deny` tri-state, and rule-merge semantics that Inkstone has shown no need for.

## Terminology

- **Agent** — the persona the user is chatting with. `readerAgent` / `exampleAgent` / future `researcherAgent`. A literal conforming to `AgentInfo`.
- **Base agent** — the shared foundation layer, conceptually. Not an instance, not a class. Everything exported from `backend/agent/base/index.ts` and contained in `backend/agent/base/tools/`.
- **Custom agent** — any agent under `backend/agent/agents/`. Reader and Example today.
- **extraTools** — tools specific to a custom agent, composed with `BASE_TOOLS` at runtime by `composeTools`.
- **BASE_TOOLS / BASE_PREAMBLE / composeTools / composeSystemPrompt** — the four canonical exports that define the base layer's public contract.
- **Foundation tools** — informal synonym for `BASE_TOOLS`. Used interchangeably in discussion; code uses `BASE_TOOLS`.
- **Command** (`AgentCommand`) — a user-invoked verb declared on `AgentInfo.commands` or in `BUILTIN_COMMANDS`. `/article`, `/clear`. Distinct from a **tool**: commands are user-facing, invoked at turn boundaries via `runAgentCommand`; tools are LLM-invoked mid-turn. See D9.
- **Tool** (`AgentTool`) — a pi-agent-core capability the LLM invokes during a turn. `read_file`, `quote_article`. Distinct from a **command**.
- **Skills** (future) — self-contained knowledge bundles (SKILL.md files) loaded on demand into conversations. See `docs/SKILLS.md`.
- **Memory files** (future) — `user.md` + `memory.md` under `~/.config/inkstone/`, inlined into the system prompt at compose time. See `docs/MEMORY.md`.
- **Pressure point** — a place where current code shape is known to strain under anticipated future work, documented with the pressure + open questions but without a pre-committed API. See D8.

## References

- Implementation reference — `docs/ARCHITECTURE.md` → "Agent Registry" section.
- Active / future work — `docs/TODO.md` → "Future Work (Post-MVP)".
- OpenCode comparison — `../opencode/packages/opencode/src/agent/agent.ts` (flat registry + permission ruleset for per-agent tool scoping).
- pi-agent-core API — `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts`.
