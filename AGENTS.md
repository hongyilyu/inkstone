# AGENTS.md

Conventions for agents (Claude Code, etc.) working in this repo.

## Working principles

Behavioral guidelines for every task. These bias toward caution over speed; use judgment for trivial work.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that *your* changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 4. Goal-driven execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after."

For multi-step tasks, state a brief plan:

```
1. [step] → verify: [check]
2. [step] → verify: [check]
3. [step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") force constant clarification.

### 5. Early-stage: destructive changes welcome

Inkstone is pre-release. There are no users, no production data, nothing to preserve. Optimize for the cleanest end state, not backward compatibility — and proactively propose incompatible changes when they buy a better design.

- **Edit migrations in place.** Collapse, rewrite, or reorder migration files freely so the set reads as the *current* schema, not its history. Don't add patch/compatibility migrations to keep an old local DB alive.
- **Nuke local DBs without ceremony.** A schema change that orphans a dev DB is fine — delete it (`INKSTONE_DB_PATH` or the OS data dir) and let Core recreate it. A "migration N was previously applied but has been modified" error means *reset the DB*, not write a patch migration.
- **Prefer destructive simplicity.** When a cleaner design needs a breaking change, take it rather than accreting shims to dodge it.

This holds until the first real user/data exists. Re-introduce migration discipline (append-only; never edit an applied migration) at that point — supersede this section then.

### 6. Finish clean: format, lint, build, test

Every task ends with the CI gate green. Before calling a task done, run — and fix what they surface:

```
pnpm format        # biome format --write . (scoped via biome.json; never touches .agents/.claude/.impeccable/generated)
pnpm lint          # biome lint
pnpm check         # tsc -b across the workspace + cargo check
pnpm -r test       # vitest (web + packages)
cargo test --manifest-path crates/core/Cargo.toml
```

- **Never run repo-wide formatters by hand** (`biome format .` over arbitrary paths, blanket `cargo fmt`). Use `pnpm format` — its scope lives in `biome.json`. If you must format a subset, pass explicit changed files. A formatting pass that reflows files your change never touched is scope-creep (violates §3).
- **Format normalizes; it does not reason.** Confirm the only non-comment, non-whitespace edits trace to your task — `git diff -w` should show just your real changes.
- Pre-existing failures unrelated to your change: name them, don't silently absorb them into your diff.

## Subagent workflows

Rules for every `Agent`/`Workflow` spawn. 429s and stalls are routine here — a failed run is an unfinished run, not a result.

- **Always spawn with `model: "fable"`** — explicitly, on every `Agent(...)` call and in every Workflow script's `agent()` options. Never inherit the session default; never downgrade on retry.
- **A failed run has not run.** API error, 429, null/partial result, stall — resume it (`resumeFromRunId`) or respawn the moment it fails. Retry until it succeeds completely.
- **Never accept partial results.** Don't `TaskStop` a workflow while retryable units remain; don't wait on a whole-batch timeout while individual agents are dead — monitor and retry per-agent.
- **Chunk fan-outs to ~2-4 concurrent agents** to dodge rate limits.
- **If an item keeps rate-limiting, do it inline yourself** rather than parking it "blocked".

## Response style

- Lead with the answer. No "let me work through this" preamble.
- One question per turn. Don't bundle branching options.
- Visualize multi-part things (HTML, tables, examples) over text walls.
- Push back when grounded. Don't capitulate to the last thing said.
- Verdict + deltas only. Skip synthesis essays.
- Cut meta-commentary about what you did or what's next.
- Strong language ("wtf", "fking") = "you lost me, restart smaller."

## Commits

Subject line: `verb(component): concise description` — lowercase, imperative, no trailing period.

- **verb** — `feat` · `fix` · `refactor` · `docs` · `test` · `chore`
- **component** — the touched area: `core` · `web` · `worker` · `protocol` · `ui-sdk` · `adr` · `skills` · or a feature slice (`journal`, `proposal`). For a PR, the trailing `(#123)` issue ref is fine.

```
feat(web): model library items explicitly
fix(core): resume re-park + proposal-decide correctness
refactor(worker): collapse transport seam
docs(adr): record client/core wire protocol
```

A change spanning packages takes the dominant component, or split into one commit per package (each is its own git repo where applicable).

Meta-artifacts (hand-off prompts, plans, analysis reports) are working files — write them to `/tmp` or `.agents/runs/`, never commit or PR them unless explicitly asked.

## Skills

Project skills live in `.agents/skills/` (exposed to Claude Code via the `.claude/skills` relative symlink). If a slash-command skill reports "Unknown skill", do not substitute a different skill — read and follow `.agents/skills/<name>/SKILL.md` directly, and flag the broken symlink (fix: `ln -sfn ../.agents/skills .claude/skills`).

## Pointers

Repo conventions live in `docs/agents/`. Domain truth lives in `CONTEXT.md` and `docs/adr/`.
