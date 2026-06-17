---
name: arch-prompts
description: Author a runnable implementation prompt (goal / desired end state / testing approach) for each surviving deepening candidate from an architecture review, then verify every claim in it against the code before emitting. Use after improve-codebase-architecture has chosen candidates, or whenever the user wants a deepening refactor turned into an executable, fact-checked prompt.
---

# Architecture Implementation Prompts

Turn a chosen **deepening candidate** into a prompt another agent (or the user) can run *without re-discovering the codebase*. The output is not advice — it is an executable brief whose every factual claim (paths, symbols, build wiring, test plumbing) has been checked against the code.

This is the downstream companion to `improve-codebase-architecture`: that skill *finds and presents* candidates; this one *operationalizes* the ones that survive. Use the same vocabulary — read [LANGUAGE.md](../improve-codebase-architecture/LANGUAGE.md) and [DEEPENING.md](../improve-codebase-architecture/DEEPENING.md) first, and stay in **module / interface / seam / adapter / depth / leverage / locality**. Don't drift to "component," "service," or "boundary."

Domain truth lives in `CONTEXT.md` and `docs/adr/`. Name modules after the concepts there. If a prompt would introduce a concept not in `CONTEXT.md`, flag it.

## When to use

- A deepening candidate has been chosen (via `improve-codebase-architecture`, a grilling loop, or the user just naming one) and the user wants it turned into something runnable.
- The user asks for "the prompt," "goal / end state / testing," an implementation brief, or to hand a refactor to an AFK agent.

## The core discipline: verify, then write

A prompt full of plausible-but-wrong paths is worse than no prompt — it sends the executor down dead ends. So **every claim is checked against the code before it lands in the prompt.** A claim is anything an executor would act on:

- File and directory paths, and that they exist.
- Symbol names (functions, types, exports) and where they're defined/used.
- **Build & packaging wiring** — how the module is compiled, bundled, depended on. (In this repo: `Cargo.toml`, `package.json`, `pnpm-workspace.yaml`, `tsconfig`, the Test Harness `spawnCore`/worker-spawn plumbing.) This is the most common place a deepening prompt is wrong.
- Test plumbing — where tests live, how they run, what fixture/mock is wired where.
- Cross-seam call sites — who imports/spawns/calls the thing being moved.

If a claim can't be confirmed, the prompt says so explicitly (`UNVERIFIED: …`) rather than asserting it. Prefer deleting a shaky step over shipping a confident wrong one.

Scale the verification to the work. For a multi-move refactor, fan out: one verifier per move (or per risky claim) reading the real files in parallel, each returning confirmed facts + contradictions, then synthesize. For a single small move, verify inline. When the session has opted into multi-agent orchestration, prefer a workflow: a verify phase (parallel, one agent per move, adversarially confirming paths/wiring/tests) → a synthesis phase that writes the prompts only from confirmed facts.

## Output: one prompt per candidate

Each candidate becomes a self-contained prompt with these sections, in this order:

0. **How to run** — the execution protocol the prompt is meant to be driven by, stated up front so the executor follows it before touching code:
   1. **ultrathink** — engage extended reasoning for the whole task; a deepening refactor has non-obvious blast radius.
   2. **grill-me** — run the `grill-me` skill to resolve every open decision *with the user* before writing any code. The prompt's open questions and `UNVERIFIED` items (see Risks) are the grilling agenda; don't pick silently.
   3. **feature-flow** — once decisions are settled, hand the resolved plan to the `feature-flow` skill to construct and execute it as vertical slices (decompose → optional contract → impl → review → verify per slice).

   This ordering is the point: think hard, *then* close the open questions with the user, *then* let feature-flow build it — never skip straight to feature-flow with decisions still open.

1. **Goal** — one or two sentences. What deepening this achieves, in [LANGUAGE.md](../improve-codebase-architecture/LANGUAGE.md) terms: which **module** gets deeper, what **leverage**/**locality** is won, what the **deletion test** says now vs. after. Not "move file X" — *why* the move deepens the module.

2. **Context the executor needs** — the verified facts: exact paths, the symbols involved, the current shape, the build/packaging wiring, who calls across the seam. Cite `file:line` where it helps. This is the section that saves the executor from re-exploring; it carries the verification's payload.

3. **Desired end state** — concrete and observable. What the module's **interface** looks like after; what file/package layout results; what the build graph looks like; what a reader sees at a glance. Written so "done" is unambiguous — an executor can diff reality against it. Include what should *no longer* exist (deleted files, retired guards, removed deps).

4. **Steps** — ordered, each tracing to a verified fact, each independently checkable. Call out ordering constraints (what must land before what) and the blast radius of each (call sites to update, configs to touch). Keep them surgical (CLAUDE.md §3) — every step traces to the goal.

5. **Testing approach** — per [DEEPENING.md](../improve-codebase-architecture/DEEPENING.md): the **interface is the test surface**; write tests at the deepened module's interface, **replace don't layer** (delete unit tests on the old shallow shape once interface tests exist). Name the actual test commands/paths for this repo (the CLAUDE.md CI gate: `pnpm check`, `pnpm -r test`, `cargo test`, the Test Harness e2e). State what proves the refactor behavior-preserving (same tests green before and after) vs. what new coverage the new seam needs. Classify each cross-seam dependency by [DEEPENING.md](../improve-codebase-architecture/DEEPENING.md) category so the executor knows whether to use a real stand-in, a port+adapter, or a mock.

6. **Risks & out-of-scope** — what could go wrong, what's deliberately *not* in this prompt, any `UNVERIFIED` claims the executor must resolve first, and any ADR that should be written/updated (offer it, per the family convention).

When there are multiple candidates, order them by dependency: if move B is cleaner after move A lands, say so and sequence them. Note which single move delivers the most depth per unit of effort (the lead recommendation).

## Style

- Match the repo's commit/▸response conventions (CLAUDE.md): answer-first, terse, visual over walls of text. A prompt is a tool, not an essay.
- The prompt is addressed to an executor with no prior context on this conversation — it must stand alone.
- Don't propose the interface design itself if it's still open — that's [INTERFACE-DESIGN.md](../improve-codebase-architecture/INTERFACE-DESIGN.md)'s job. This skill assumes the shape is chosen and makes it runnable.
- End by asking whether to run any of the prompts (spawn the executor) or hand them over as-is.
