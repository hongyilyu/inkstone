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

## Response style

- Lead with the answer. No "let me work through this" preamble.
- One question per turn. Don't bundle branching options.
- Visualize multi-part things (HTML, tables, examples) over text walls.
- Push back when grounded. Don't capitulate to the last thing said.
- Verdict + deltas only. Skip synthesis essays.
- Cut meta-commentary about what you did or what's next.
- Strong language ("wtf", "fking") = "you lost me, restart smaller."

## Pointers

Repo conventions live in `docs/agents/`. Domain truth lives in `CONTEXT.md` and `docs/adr/`.
