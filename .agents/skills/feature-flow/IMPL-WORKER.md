# IMPL-WORKER.md (SOP for the Worker impl subagent)

You are the Worker impl agent. You own `packages/worker/**` for this run. Parallel with the Core and UI agents.

## Inputs

The orchestrator passes a prompt envelope at the top of your prompt. Read these fields before anything else: `SLUG`, `SLICE`, `ITERATION`, `RUN_DIR`, `SLICE_DIR`, `SLICE_BASE`, `SLICE_BRANCH`, `OUTPUT_PATH`, `PRIOR_FINDINGS`. See feature-flow/SKILL.md "Subagent prompt envelope".

- `FEATURE-PLAN.md` at `RUN_DIR/FEATURE-PLAN.md` — find this slice's section
- `SLICE_DIR/DECOMPOSE.md` — this slice's owned files and RED test (per-slice DECOMPOSE.md is single-component; you are the component)
- `RUN_DIR/slices/<m>/CONTRACT-DELTA.md` for any earlier slice that introduced contract changes
- `CONTEXT.md` — domain vocabulary
- Worktree on `SLICE_BRANCH` off `SLICE_BASE`. Diff scope: `git diff <SLICE_BASE>..HEAD`.
- If `PRIOR_FINDINGS` is non-empty, address every `fail`-verdict finding.

## Mandate

Implement this slice per `SLICE_DIR/DECOMPOSE.md`. **Only** edit files listed under "Owned files" in that file.

## TDD discipline

Per [`tdd`](../tdd/SKILL.md): **vertical slices, not horizontal**. For each task, write one test, make it pass, then move on.

For each task:

1. **RED**: Smallest failing test. Commit: `test(worker): <slug> — <brief>`.
2. **GREEN**: Minimum code to pass. Commit: `worker: <slug> — <brief>`.
3. Move on.

**Carve-out: test infrastructure missing.** All three must hold:

1. `packages/worker` has no test infrastructure at `SLICE_BASE` (no `test` script in `package.json`, no test runner in `devDependencies`, no `__tests__/` or `*.test.ts`).
2. **The slice's plan section does not itself bootstrap infrastructure.** If your owned files include adding a `test` script, a test runner dep, or a new test file, the slice IS the bootstrap — carve-out does **not** apply, run RED→GREEN.
3. You document the carve-out invocation in your return summary.

If the carve-out applies, you may skip RED and only commit GREEN. Otherwise, run RED→GREEN normally. Prefer to bootstrap a minimal test setup (e.g., add `vitest` and a `test` script) if the plan doesn't forbid it.

**Bootstrap-into-RED.** When this slice bootstraps test infra (adding `vitest` + `test` script + `vitest.config.ts`), do **not** make a separate `worker: bootstrap vitest` commit before your test. The dep-adds, scripts, and runner config belong in the same commit as your failing test — that's why they exist. The first commit's message stays `test(worker): <brief>` and its diff contains the test file plus the `package.json`/config changes.

## Steps

1. Read `SLICE_DIR/DECOMPOSE.md`. Note owned files, the slice's RED test, and any touchpoints (Run Events emitted, Tool Requests sent).

2. Read any upstream `RUN_DIR/slices/<m>/CONTRACT-DELTA.md` if present. The protocol package is upstream; you import its types.

3. Run the RED→GREEN cycle for the slice's behavior (or GREEN-only with carve-out).

4. Run gates:
   - `pnpm -C packages/worker check` (this repo's convention for typecheck)
   - `pnpm -C packages/worker test` only if a `test` script exists in `packages/worker/package.json`

5. Confirm commit pattern via `git log --oneline <SLICE_BASE>..HEAD`. Do **not** use `master..HEAD` — it includes prior slices' commits and gives a misleading log.

6. Write summary to `OUTPUT_PATH` and return it: cycles run, gates passed, drift from plan, carve-out invocation if any, prior findings addressed.

## Rules

- **File boundary.** No edits outside `packages/worker/**`. Cross-component need = `BLOCKED.md`.
- **`docs/adr/` is out of scope.** ADRs are planning artifacts. If your slice contradicts a consulted ADR or surfaces a new architectural decision, write `BLOCKED.md` and stop. Never author or amend an ADR from impl.
- **Run Events are one-way (ADR-0006).** Don't expect a response. Don't merge them with Tool Requests.
- **Tool Protocol is bidirectional.** Tool Request → Tool Result. Don't fire-and-forget a Tool Request.
- **The Worker drives Turns. Core owns Runs.** Don't try to persist Run state from the Worker — emit Run Events and let Core record (ADR-0012).
- **Workflow shape.** A Workflow has a system prompt, tool allowlist, model choice, and bootstrap context (ADR-0018). One Run executes one Workflow.
- **Don't reach into Core internals.** Communicate via Run Events and Tool Protocol.

## When to fail

- Required Tool Request type missing → `BLOCKED.md`.
- Run Event subtype the plan asks for is not in the contract delta → `BLOCKED.md`.
- A change would contradict an ADR → `BLOCKED.md`.
