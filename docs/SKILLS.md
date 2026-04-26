# Inkstone — Skills Design

Dedicated design doc for the skills system. Captures the exploration done during the agent architecture thread; implementation deferred. Pick up from here when returning to the feature.

**Status: exploration captured, implementation deferred.** The agent shell is ready to absorb skills — `BASE_TOOLS` can take a `skill` tool, `composeSystemPrompt` can inject a summary — but the loader, discovery, and filtering shape all want real SKILL.md bundles + a loader to shape them before committing to an API.

## 1. Problem

Agents should be able to pull in self-contained knowledge modules on demand without inflating every turn's system prompt. A skill might be:

- A specialized workflow (e.g. "how to query a Postgres schema").
- A reference cheat-sheet (e.g. "common Obsidian frontmatter keys").
- A task-specific prompt fragment (e.g. "how to structure a literature review").

Inlining all skills an agent might need into every system prompt is wasteful when most aren't used in a given turn. Letting the agent discover and load them on demand is the pattern OpenCode and Claude Code converged on.

## 2. Current state

- No skills system.
- `BASE_TOOLS` contains only `read_file`.
- `BASE_PREAMBLE` is empty.
- `AgentInfo` has no `skills` field.

## 3. Known shape

From the design discussion:

- **Skill bundles** — `SKILL.md` files with YAML/TOML front-matter (name, description, optionally `agents:` allowlist) + markdown body. One file per skill.
- **Storage** — under `~/.config/inkstone/skills/<name>/SKILL.md`. Explicitly not inside the vault (per AGENT-DESIGN.md D7 — vault is knowledge content, config dir is Inkstone state).
- **Lazy loading** — summary (name + description) surfaced in the system prompt at compose time, full body fetched on demand when the agent invokes a skill-loading tool. Avoids token bloat.
- **Agent-created skills** — part of the design intent. Agents should be able to author new SKILL.md bundles at runtime (e.g. KB agent writing a skill for a newly-ingested domain). Exact mechanism TBD (see §5).

## 4. User's framing from the design discussion

> "once we load the memory.md, user.md, agent instructions, tools, we will also load skills per project"

Composition order at session boot roughly:

```
system prompt =
  BASE_PREAMBLE preamble
  + user.md                  (see docs/MEMORY.md)
  + memory.md                (see docs/MEMORY.md)
  + agent's buildInstructions()
  + skills summary           (this doc)
  + environment block        (date, vault, etc.)
```

## 5. Open questions at implementation time

- **Summary placement**: before or after memory files? Semantically: memory is "what the agent knows by default"; skills are "what the agent can pull in when relevant". Probably memory → skills summary → agent instructions. Confirm when the loader exists.
- **Filtering model** (per-agent visibility):
  - *Agent-driven*: `AgentInfo.skills: string[]` whitelists skill names.
  - *Skill-driven*: SKILL.md front-matter declares `agents: [reader, researcher]` allowlist.
  - Leaning agent-driven (keeps agent self-contained; skill doesn't need to know who uses it), but not committing without the first concrete loader.
- **Field shape on `AgentInfo`** — if filtering is agent-driven. Could be `skills: string[]` (names), `skills: RegExp[]` (patterns), or no field at all if the loader handles it. Probably `string[]` is the simplest; pattern or glob support is speculative.
- **Loader location** — `backend/skills/loader.ts`? Or colocated with `base/`? Decide when writing the first loader.
- **Full-body load mechanism** — a `skill` tool added to `BASE_TOOLS` (invoked by the LLM mid-turn when it decides the task matches a skill summary). OpenCode's pattern. Tool takes a skill name, returns the full body as its result; pi-agent-core threads that into the turn as a user-scoped tool result.
- **Agent-created skills** — mechanism TBD. Could be a `skill_write` tool in `BASE_TOOLS` (similar to `memory_write` — see docs/MEMORY.md), or the agent invokes `write_file` directly against the skills directory. Probably the former for consistency; decide when implementing.
- **Caching / invalidation** — if the loader reads SKILL.md files from disk on every session boot, skill authors can edit and see changes without restarting. But a watch-mode might be overkill. Start with read-on-boot, cached for the session.
- **Discovery beyond `~/.config/inkstone/skills/`** — should the tool also check `.agents/skills/` in the project root (dev skills)? OpenCode does multi-path discovery. For Inkstone single-path is simpler; expand if the first user asks for project-scoped skills.

## 6. Why defer the shape

Every one of the open questions is cheap to decide *after* a real loader exists and the first two or three SKILL.md bundles are authored. Deciding now risks porting OpenCode's shape without the constraints that would have justified it. Per AGENT-DESIGN.md D8, "deferred features are pressure points, not APIs."

Concretely: the `skill` tool shape, the summary-injection point in `composeSystemPrompt`, and the filtering model all get much easier to design against three real skills (one agent-created, one user-authored, one shipped with Inkstone) than against zero.

## 7. When to revisit

Triggers that suggest it's time to build this:

1. An agent's system prompt crosses ~10k tokens and a chunk of it is "here's how to do X if the user asks" — candidate skill content.
2. A user asks for a way to share reusable workflows across sessions.
3. A second agent (Researcher, KB) lands that has a natural set of domain-specific workflows it would benefit from loading on demand.
4. A concrete use case emerges for agent-created skills (e.g. KB wants to save a skill per knowledge domain it builds up).

Any one of the above is sufficient. Two or three at once is strong signal.

## 8. Implementation sketch (for when the time comes)

Minimum viable path:

1. **Define** `Skill = { name: string; description: string; body: string; agents?: string[] }` in `backend/skills/`.
2. **Loader** — `loadSkills(): Skill[]` reads all `~/.config/inkstone/skills/*/SKILL.md`, parses front-matter, returns array. Cached module-level. Re-run on explicit refresh or app restart.
3. **Filter** — `availableSkillsForAgent(agentName: string): Skill[]` applies either agent-driven or skill-driven filtering (decide at implementation time).
4. **Summary injection** — `composeSystemPrompt` grows: after `BASE_PREAMBLE`, insert a `## Available Skills\n\n<name>: <description>\n...` block listing visible skills for the current agent.
5. **Loading tool** — `skillTool` in `BASE_TOOLS`. Takes `{ name: string }`, returns the skill's full body as tool result content. The LLM invokes when it decides the task matches a skill.
6. **Agent-created skills (if in scope)** — `skillWriteTool` or similar. Takes `{ name, description, body }`, writes to `~/.config/inkstone/skills/<name>/SKILL.md`. After write, the cached skill list refreshes.

No `AgentInfo` changes required if filtering is skill-driven (front-matter `agents:`). If agent-driven, add `skills?: string[]`.

## 9. References

- AGENT-DESIGN.md D7 — vault ≠ config (why skills go under `~/.config/inkstone/`, not the vault).
- AGENT-DESIGN.md D8 — deferred features are pressure points, not APIs (why this doc exists instead of committing to a shape).
- OpenCode's skill system — `../opencode/packages/opencode/src/skill/index.ts` and related (multi-path discovery, `skill` tool, front-matter parsing).
- MEMORY.md — sibling feature (user.md + memory.md). Composition order interacts with skill summary placement.
