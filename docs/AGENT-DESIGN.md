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

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Class hierarchy (`BaseAgent` → `ReaderAgent`) | See D1. Industry pattern is flat + composition; inheritance fights divergence. |
| OpenCode-style permission ruleset per agent | Overkill at 2–3 agents. Today's `guard.ts` covers vault scoping + confirmations. Revisit when an agent needs truly different tool access from its peers. |
| Global tool registry + per-agent allow/deny rules | Same reasoning as above — pattern-driven permissions are the power answer; we don't have the demand yet. |
| User-defined agents via `.md` files | Out of scope for the dev-facing redesign. Revisit if an end-user path becomes relevant. |
| Eager-load all skills at session boot | When skills land, we'll use lazy loading via a `skill` tool (OpenCode pattern) — summaries in the system prompt, full bodies on demand. Eager loading inflates tokens on every turn even when a skill is never used. |
| Skill bundles colocated under `agents/<name>/skills/` | User direction: skills are agent-created or global, not colocated. Will live under `~/.config/inkstone/skills/`. |
| `memory.md` / `user.md` inside the vault (e.g. `$VAULT/.inkstone/`) | Rejected in design discussion — see D7. |
| Session.json colocated with vault | Same as above. |
| Subagent delegation via a `task` tool (OpenCode pattern) | Single agent per session is the Inkstone constraint today. Revisit if a concrete use case (e.g. Reader delegating a targeted search to Researcher) emerges. |
| `foundationTools?: boolean` opt-out on `AgentInfo` | See D4. Coarse opt-out speculative for one agent's aesthetic. |

## Extension points (design for future PRs)

These are the places designed to absorb future features. Each is a specific, small edit surface — not a "redesign" — because the base layer was built to accept them.

### Skills (deferred)

Shape when it lands:

- `AgentInfo` gains `skills?: string[]` — list of skill names this agent may load.
- A new `skillTool` in `BASE_TOOLS` — loads a skill's full body into the conversation on demand.
- `composeSystemPrompt` grows to inject a summary (name + description per skill in `info.skills`) into the prompt, right after `BASE_PREAMBLE`.
- Skill bundles live in `~/.config/inkstone/skills/<name>/SKILL.md` with front-matter (`name`, `description`) + body. Agent-created skills (an agent authoring a new bundle at runtime) are part of the design intent — exact mechanism TBD.
- Filtering model: either skill declares `agents: [...]` in front-matter, or agent declares `skills: [...]` whitelist. Decision made at implementation time.

### Memory files (deferred)

- `user.md` — user preferences (communication style, domain interests). Written by the user.
- `memory.md` — durable facts: environment details, project conventions, discovered workarounds, lessons learned. Written by the agent.
- Both under `~/.config/inkstone/`.
- A new `memoryWriteTool` in `BASE_TOOLS` — append/update `memory.md`. `user.md` stays user-authored.
- `composeSystemPrompt` grows to inline both files' contents after `BASE_PREAMBLE`.
- No auto-summary initially; writes are explicit and agent-driven.

### Per-agent session actions (deferred)

Today `AgentActions.loadArticle` is reader-shaped vocabulary on a "generic" action surface — the shell still knows reader owns `activeArticle` state (re-exported via `agents/reader/index.ts`). Proper fix when a second agent needs its own session state:

- `AgentInfo.sessionActions?: Record<string, (arg: any) => void>` — agent declares its per-session verbs.
- A generic `runAgentAction(name: string, arg: any)` on `AgentActions` — dispatches to the current agent's registered action.
- TUI's `/article` command becomes one dispatch path among many; other agents contribute their own verbs (e.g. Researcher's `/topic`, Knowledge Base's `/ingest`).

### BASE_TOOLS immutability (deferred)

`BASE_TOOLS` is an exported mutable array. Nothing prevents `BASE_TOOLS.push(...)` from outside `base/`. When a second module wants to contribute a base tool (memory module, skills module, or future plugin system), replace the export with a `registerBaseTool(tool)` function + frozen getter so the extension contract is enforced, not implicit.

Same hazard applies to any future `BASE_SKILLS` or `BASE_PREAMBLE_FRAGMENTS` collection.

### Web search (deferred)

A new `webSearchTool` in `BASE_TOOLS` once a provider / API is chosen. Universal capability — every agent benefits from research.

### Per-agent permissions (deferred)

If and when a 2nd agent needs truly different tool access (e.g. Researcher can read everywhere in the vault, but Reader is still scoped to `ARTICLES_DIR` for writes):

- `AgentInfo.permission?: Ruleset` — OpenCode-style allow/deny rules per agent.
- Plumbed into the `beforeToolCall` guard, layered over the default guard rules.
- Possible this stays as-is indefinitely if our concrete agents all share the same guard model. Not speculatively built.

## Terminology

- **Agent** — the persona the user is chatting with. `readerAgent` / `exampleAgent` / future `researcherAgent`. A literal conforming to `AgentInfo`.
- **Base agent** — the shared foundation layer, conceptually. Not an instance, not a class. Everything exported from `backend/agent/base/index.ts` and contained in `backend/agent/base/tools/`.
- **Custom agent** — any agent under `backend/agent/agents/`. Reader and Example today.
- **extraTools** — tools specific to a custom agent, composed with `BASE_TOOLS` at runtime by `composeTools`.
- **BASE_TOOLS / BASE_PREAMBLE / composeTools / composeSystemPrompt** — the four canonical exports that define the base layer's public contract.
- **Foundation tools** — informal synonym for `BASE_TOOLS`. Used interchangeably in discussion; code uses `BASE_TOOLS`.
- **Skills** (future) — self-contained knowledge bundles (SKILL.md files) loadable into conversations on demand via a `skill` tool.
- **Memory files** (future) — `user.md` + `memory.md` under `~/.config/inkstone/`, inlined into the system prompt by `composeSystemPrompt`.
- **Session actions** (future) — agent-declared verbs exposed through a generic `runAgentAction` dispatch on `AgentActions`. Today only reader's `loadArticle` exists, as a special case hard-wired in the shell.

## References

- Implementation reference — `docs/ARCHITECTURE.md` → "Agent Registry" section.
- Active / future work — `docs/TODO.md` → "Future Work (Post-MVP)".
- OpenCode comparison — `../opencode/packages/opencode/src/agent/agent.ts` (flat registry + permission ruleset for per-agent tool scoping).
- pi-agent-core API — `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts`.
