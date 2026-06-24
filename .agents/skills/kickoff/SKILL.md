---
name: kickoff
description: One front door that turns any build request — a new feature OR a deepening refactor — into a researched, grilled, verified, runnable plan for inkstone. Detects the mode, researches comparable implementations in the local ~/dev reference repos and recommends the best fit before offering options, verifies every code anchor against the repo, grills open decisions with the user, then hands a runnable sliced FEATURE-PLAN.md to feature-flow. Use when the user wants to kick off / scope / plan / hand off a feature or refactor, says "kickoff", "write the plan/prompt for X", "thread-starter for X", or hands a candidate/issue to operationalize.
---

# Kickoff

One front door for starting work. The user invokes this with anything — a feature idea, an issue #, a deepening-refactor candidate — and the skill drives a fixed pipeline that ends with a runnable plan `feature-flow` executes. The output is not advice; it is an executable plan whose every factual claim has been checked against the code.

## Two modes, one spine

Detect the mode from the request, then run the SAME pipeline:

- **feature** — a new capability or product behavior (an issue, a roadmap item, "add X"). Speak in product terms.
- **refactor** — deepening existing structure (move/collapse/extract, "make module X deeper"). Downstream of `improve-codebase-architecture`. Speak in: **module / interface / seam / adapter / depth / leverage / locality** — don't drift to "component," "service," or "boundary." The goal is *why the change deepens the module* (what the deletion test says now vs. after), never "move file X."

If the request fits neither cleanly, ask which. Domain truth lives in `CONTEXT.md` and `docs/adr/`; name things after the concepts there and flag any concept a plan would introduce that isn't in `CONTEXT.md`.

## The pipeline (every invocation, both modes)

1. **ultrathink + classify.** Engage extended reasoning for the whole task (blast radius is non-obvious). Pick the mode. If it maps to an issue/ADR, read them (`gh issue view <n>`, `docs/adr/*`).

2. **Research — ALWAYS, regardless of mode.** Run a workflow that inspects the LOCAL reference repos under `~/dev` (see map) for how comparable projects implement this feature/refactor class. **`git -C ~/dev/<repo> pull` each first** to ensure latest. Analyze which approach best fits inkstone (local-first, single-user, Rust Core + TS Worker + React web, approval-sacred), and **land on a recommended solution with concrete references (repo path + file) BEFORE presenting the user any options** — never open with a menu.

3. **Verify, then write.** Every claim an executor would act on — file/dir paths, symbol names, build & packaging wiring (`Cargo.toml`, `package.json`, `pnpm-workspace.yaml`, the Test Harness spawn plumbing), test plumbing, cross-seam call sites, the contract-parity gate (`EntityRow`/`EntityListResult` & other fixtured wire types) — is grepped/Read against the repo *now*. An unchecked `file:line` is a bug. If a claim can't be confirmed, mark it `UNVERIFIED:` rather than asserting it; prefer dropping a shaky step over shipping a confident wrong one. Scale verification to the work: fan out one verifier per risky claim for a big change, inline for a small one.

4. **Grill.** Run the `grilling` skill to resolve every open decision *with the user*, one question per turn, each carrying your research-backed recommended answer. The open questions + every `UNVERIFIED:` item are the agenda. Don't pick silently; don't skip ahead with decisions still open.

5. **Hand to feature-flow.** Once decisions are settled, invoke the `feature-flow` skill with the resolved understanding. feature-flow owns slicing and execution: it writes the runnable `.agents/runs/<slug>/FEATURE-PLAN.md` (Goal / components / test-infra / vertical slices each with a RED test / acceptance criteria / ADRs / out-of-scope) and runs the slice loop. Do not reinvent slicing here — this skill front-loads research, verification, and grilling so feature-flow's intake has nothing left to ask.

This ordering is the point: **think hard → research the field → verify reality → close decisions with the user → let feature-flow build.** Never jump to feature-flow with decisions still open or anchors unverified.

## Local reference repos (`~/dev` — pull each before reading)

Research inspects these CLONES, not the web. Name 2-4 whose class matches — don't list all five reflexively.

| Repo | What it is | Reach for it on |
| --- | --- | --- |
| `pi` | `pi.dev` / `pi-ai` — the LLM-provider lib the Worker actually depends on | streaming, reasoning/thinking tokens, provider/model, tool-call protocol |
| `opencode` | opencode.ai coding agent (TS/Bun monorepo, has CONTEXT.md) | agent loop, segment/turn rendering, extraction, tool surfaces |
| `t3code` | minimal web GUI for coding agents (renders reasoning streams) | chat UI, reasoning/thinking display, message timeline, web UX |
| `openclaw` | personal AI assistant (TS, extensions) | capture, personal-knowledge UX, assistant ergonomics |
| `hermes-agent` | Python agent framework (ACP adapter, CLI) | agent orchestration, workflow/dispatch patterns |

## Rules

- **Verify before you cite.** Anchors are this skill's whole value; re-grep at hand-off time.
- **Research is local + recommend-first.** Read the `~/dev` clones (pull first); arrive at a recommendation with repo+file references before offering options — in BOTH modes.
- **Stay in the domain language** of `CONTEXT.md` / `docs/adr/`. For refactor mode, stay in module/seam/depth vocabulary and don't design the interface if it's still open — that's a grilling question.
- **Multiple candidates:** order by dependency (B is cleaner after A → sequence), call out the one-parity-gate-at-a-time rule, and name the lead recommendation (most depth/value per unit effort).
- **ADRs are planning artifacts** — when a decision is hard-to-reverse + surprising-without-context + a real trade-off, author/amend `docs/adr/NNNN-*.md` during grilling, with the user. Impl agents may not write them later.
- End by asking whether to run feature-flow now or hand the plan over as-is.
