# Skills: drop-in markdown procedures the model loads mid-Run

/ amends [ADR-0011](./0011-per-run-workflow-dispatch.md), [ADR-0018](./0018-workflow-and-tools-definition.md)

CONTEXT.md commits to one capable default Workflow and lists "skill" under
Workflow's _Avoid_ — the stance being "a skill is just another Workflow, don't
invent a parallel concept." That stance was right while the only way to make Core
*do more* was to author another system prompt. But the work we actually want to
add — a GTD weekly-review ritual, a trip-planning capture flow, an inbox-triage
procedure — is not N frozen behavior bundles the Dispatcher routes between. It is
**one broad assistant that occasionally needs a specialized procedure**, pulled in
only when the conversation calls for it.

That is the **Agent Skills standard** (the `SKILL.md` convention shared by
Claude, Codex, and openclaw): a skill is a markdown procedure with a one-line
description; the model is shown the descriptions, recognizes when one applies, and
loads the full body on demand. This ADR adopts it, adapted to inkstone's
Core/Worker split.

## Decision

Add **Skill** as a first-class concept, distinct from Workflow. A Skill is a
directory containing a `SKILL.md` — YAML frontmatter (`name` + `description`
required) and a markdown body — that describes a procedure for the assistant to
follow. A Skill is *content the model reads*, never code Core executes.

Four mechanisms, all owned by Core (Rust):

1. **Discovery — Core scans a skills directory.** At manifest-build time
   (`worker/mod.rs::workflow_manifest`), Core scans `<skills dir>/*/SKILL.md`,
   parses each frontmatter, and drops any skill missing `name` or `description`.
   The directory is `<OS data dir>/inkstone/skills/`, overridable with
   `INKSTONE_SKILLS_DIR` (mirroring `INKSTONE_WORKFLOWS_DIR` and
   `INKSTONE_DB_PATH`). The scan runs **per dispatch**, not once at boot — drop a
   skill in and the next Run sees it, no restart.

2. **Disclosure — Core injects descriptions, not bodies.** Core appends an
   `<available_skills>` block to the effective Workflow's `system_prompt`, listing
   each eligible skill's `name` and `description` only, with the instruction:
   *"if one clearly applies, load it with `load_skill`, then follow it; if several
   apply, choose the most specific; if none apply, load none."* The bodies are
   **not** in the manifest — only the cheap metadata is.

3. **Activation — a `load_skill(name)` Core tool.** A single Rust tool,
   `load_skill`, is added to **every** Run's effective tool allowlist
   (alongside the Workflow's own `tools`). When the model decides a skill applies,
   it calls `load_skill("weekly-review")`; Core reads that skill's `SKILL.md` body
   off disk and returns it as the Tool Result. The body enters context as tool
   output, mid-Run. This is true progressive disclosure within a **frozen
   manifest**: the tool list never changes, context grows only when the model pulls.

4. **Composition — skills compose existing tools; they add none.** A Skill body
   instructs the model how to use tools that are *already* registered in Core
   (`propose_workspace_mutation`, `search_entities`, …). A Skill cannot introduce a
   tool: Core's registry is the authority (ADR-0018), and the allowlist is
   re-enforced on every `tool_request` (`tools::is_allowed`, `worker/run.rs:294`).
   A skill that "needs a
   new tool" is a request to extend Core's Rust registry — a separate,
   code-reviewed change, not something a dropped-in markdown file can do.

"Core does more than journaling" is delivered by (a) broadening the single default
Workflow's prompt + tool allowlist so it is *capable* of more, and (b) dropping in
skills that *guide* it through specific procedures. There is no second Workflow and
no Router (ADR-0011's Dispatcher stays a one-liner).

## Why `load_skill(name)`, not the Worker reading the file

openclaw's model is "the runtime reads `SKILL.md` with its `read` tool." inkstone's
Worker has no filesystem surface — ADR-0003 makes Core the sole chokepoint for
durable state and Core-owned resources, and ADR-0018's Worker is a generic
interpreter that only ever proxies tool calls back to Core. Letting the Worker open
skill files directly would punch a hole in that chokepoint and leak Core's
on-disk layout into the Worker.

So the read goes *through* Core, and it goes **by name, not by path**. The literal
openclaw move — inject absolute paths and expose a generic `read_file(path)` —
would hand the model a general filesystem-read primitive and force a sandbox to
keep it inside the skills dir. `load_skill(name)` gives identical progressive
disclosure while Core retains total control over what is loadable: the name is a
key into the set Core just scanned, nothing else is reachable. This is the **one**
deviation from the standard, and it is forced by ADR-0003, not chosen for taste.

The tool is read-only with respect to durable Workspace state (it reads a config
file; it touches no tier-2 row), so it sits comfortably inside
Core as Rust with no Proposal and no special policy.

## Why skills live in Core-managed config, not a user notes folder

"Drop a skill into your notes" is the seductive framing, but a user-managed notes
directory is not something Core can treat as authority — Inkstone owns its content
in tier-2 SQLite, not in an external folder. Skills are authoritative
input to a Run, so they belong with the other Core-owned, Core-authored state: the
application-data directory next to the SQLite database (`<data dir>/inkstone/`).
This also matches openclaw's own *managed* skills root (`~/.openclaw/skills`).

The ergonomic survives: dropping a directory into
`~/Library/Application Support/inkstone/skills/<name>/` (macOS) is still "drop it in
and Core picks it up." It is simply the app's data dir.

## Trust: markdown migrates, code never does

A Skill body is **untrusted prompt content** — it is, by construction, instructions
fed to a model, the same trust class as a user Message. It is never executed. The
frontmatter carries no `handler`, no script reference, no install spec; a Skill
cannot run code and cannot reach durable state except by instructing the model to
call an already-allowlisted tool, which Core validates exactly as it validates any
other tool call. This is the line the openclaw/Hermes migration drew the hard way
("skills migrate, plugins are archive-only, because foreign code can't be
auto-trusted") — inkstone gets it for free by keeping skills code-free from day one.
If an executable handler is ever wanted, it must come from Core-managed config under
the read-only-w.r.t.-durable-state criterion of ADR-0018 — never from a
dropped-in file by default.

## Frontmatter shape

```markdown
---
name: weekly-review
description: >-
  Guide a GTD weekly review — surface active Projects due for review, walk the
  user through each, and propose status or next-action updates. Use when the
  user asks to do their weekly review or review their projects.
---

# Weekly review

1. Call `search_entities` for active and on-hold Projects…
2. For each Project due for review, …
3. Propose updates one at a time via `propose_workspace_mutation`…
```

Only `name` + `description` are required and only they reach the prompt — exactly
the Agent Skills standard. inkstone ignores openclaw's `metadata`/`requires`/
`install`/`os` fields: those gate skills that shell out to external CLIs, and
inkstone skills only compose existing Rust tools, so there is nothing to gate. A
skill is eligible iff it parses and has both required fields. Keeping the format a
strict subset of the standard means community skills drop in unchanged and a future
import path is trivial.

## Consequences

- **CONTEXT.md gains a `Skill` term** and Workflow's `_Avoid_: skill` line is
  removed. Skill and Workflow are now distinct: a Workflow is the per-Run behavior
  bundle (system prompt + tool allowlist + model) selected by the Dispatcher at Run
  start; a Skill is a procedure the *model* loads mid-Run to guide itself within
  that Workflow. One Run runs one Workflow and may load zero or more Skills.

- **The Dispatcher does not route on skills.** ADR-0011's seam stays a one-liner
  returning the single default Workflow. Skill selection is the model's job,
  mid-Run, via the injected descriptions — not a Core-side classifier at spawn.
  "Pick it up when needed" is the model self-selecting, not a Router.

- **The manifest stays frozen (ADR-0018 holds).** No mid-Run manifest mutation, no
  new protocol frame. Skill descriptions ride in `system_prompt`; bodies ride back
  as ordinary `tool_result` content. `load_skill` is one more `CoreToolDescriptor`
  in the existing `tools` array.

- **`load_skill` is always allowed.** It is appended to the effective allowlist for
  every Run, so the dual-gate check (`workflow.tools` ∧ `is_registered`) in
  `tools::is_allowed` (`worker/run.rs:294`) must treat it as permitted regardless of the Workflow's own
  `tools`. Simplest form: register it like any tool and have the manifest builder
  always include it.

- **Per-dispatch scan cost.** Scanning a handful of small files on each Run is
  negligible; if it ever shows up, an mtime-gated cache is additive and changes no
  contract. Skills are explicitly **not** loaded into a boot-time `OnceLock` (that
  would defeat drop-in).

- **A bad skill file fails soft, not at boot.** Unlike `default.toml` (fail-fast at
  boot, ADR-0018), a malformed or incomplete `SKILL.md` is simply skipped during the
  scan and logged — one bad dropped-in file must not take down Core. This is a
  deliberate difference in failure posture from the Workflow loader.

- **Bundled example skills seed the dir on first run.** A fresh install's skills
  dir is empty, so the feature would be inert until the user authors a skill. Core
  ships a few canonical examples in-repo (`crates/core/skills/`, embedded with
  `include_str!`) and, at boot, writes them into the skills dir **only when that
  dir does not yet exist**. Once it exists it is the user's: edits and deletes
  survive and Core never re-seeds (drop-in ownership). This is the minimal
  delivery mechanism, not the deferred *plugin distribution* concept below — a
  skill is still a directory you place, the seed just primes the first one.

## Considered and rejected

- **Skill = a Workflow; the Dispatcher routes between many.** "Drop a skill in" =
  add a `*.toml` in `workflows/`; "Core does more" = more Workflows; "pick when
  needed" = a real Router in `dispatch()`. Rejected: it commits the whole Run to one
  frozen bundle chosen at spawn, can mis-route before the conversation reveals
  intent, and fragments one capable assistant into N prompt-forks. It also is not
  what the Agent Skills standard means by "skill." Workflow-as-template remains
  available later for a genuinely different mode (not a procedure).

- **Front-load the best-matching skill at dispatch.** Keyword/LLM-match a skill on
  its description in `dispatch()` and bake its full body into `system_prompt` before
  spawn. Rejected: zero new protocol, but it abandons progressive disclosure and
  "model loads when needed" — it commits to one skill at Run start, pays its full
  context cost on every Run whether used or not, and mis-matches with no recovery.
  The `load_skill` round-trip is cheap and keeps selection where the standard puts
  it: in the model's hands, mid-Run.

- **Generic `read_file(path)` with injected absolute paths (literal openclaw).**
  Rejected: leaks Core's filesystem layout into the Worker and hands the model a
  general read primitive that must then be sandboxed to the skills dir.
  `load_skill(name)` is the same disclosure with a far smaller blast radius. (If
  bundled skills later ship sibling `references/` files the body wants to pull, add
  a `load_skill_resource(name, relpath)` with Core-side path containment — still
  by-name-rooted, never a raw path.)

- **Skills in a user notes folder (`<notes>/skills/`).** Rejected: Core owns its
  content in tier-2 SQLite and treats no external folder as authority. Skills are
  authoritative Run input and belong in Core-managed config.

- **Skills register new tools.** Rejected: contradicts ADR-0018's Rust-only registry
  and ADR-0003's chokepoint; a dropped-in markdown file conjuring a callable tool is
  exactly the foreign-code trust hole the Hermes migration refused. New tools are a
  Rust PR.

- **Boot-time load like the single Workflow.** Rejected: an `OnceLock` requires a
  restart to see a new skill, defeating drop-in. Per-dispatch scan is the point.

## What this ADR does not decide

- **User-invocable skills / slash commands.** openclaw lets a skill be a `/command`
  the user fires directly (`user-invocable`, `command-dispatch`). Out of scope here;
  v1 is model-invocation only. Additive later via frontmatter flags.

- **Multi-skill context budgeting.** The model may load more than one skill in a
  Run; v1 imposes no Core-side cap and no truncation, relying on the "choose the most
  specific" instruction. If skill bodies grow large enough to pressure context, a
  budget/compaction pass (as openclaw has) is additive.

- **Plugins as a distribution unit.** openclaw wraps skills (and tools/providers) in
  installable plugins. inkstone has no plugin concept and this ADR does not add one;
  a skill is a directory you place, not a package you install. If a distribution
  story is wanted later, it can publish into the same scanned dir.

- **A `load_skill_resource` for bundled skill assets.** Reserved (see rejected
  alternative above); unneeded until a skill ships `references/`/`scripts/` the body
  must pull.

- **Skill versioning.** `SKILL.md` carries no version field in v1. Unlike a
  Workflow (whose `version` is snapshotted into `runs`), a loaded skill body is
  transient Run context; if provenance of *which* skill version guided a Run becomes
  useful, add it then.

## Related

- [ADR-0011](./0011-per-run-workflow-dispatch.md) — Dispatcher seam. Unchanged: it
  still returns the single default Workflow; skills are not routed.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — Workflow-as-data, generic
  Worker, Rust-only tool registry. This ADR extends the manifest's `system_prompt`
  and `tools` within those rules and adds the `load_skill` tool.
- [ADR-0003](./0003-worker-via-tool-protocol.md) — Tool Protocol chokepoint. The
  reason skills load by-name through Core rather than by the Worker reading files.
- [ADR-0004](./0004-three-tier-storage-authority.md) — tier model. The reason skills
  live in Core-managed config: Core treats no external folder as authority.
- CONTEXT.md `Workflow`, `Dispatcher`, `Router` — gain a sibling `Skill` term;
  Workflow's `_Avoid_: skill` is removed.
