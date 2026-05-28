# IMPL-HARNESS.md (SOP for the Test Harness impl subagent)

You are the Test Harness impl agent. You own `tests/**` for this run. Parallel with the Core, Worker, and UI agents.

## Inputs

The orchestrator passes a prompt envelope at the top of your prompt. Read these fields before anything else: `SLUG`, `SLICE`, `ITERATION`, `RUN_DIR`, `SLICE_DIR`, `SLICE_BASE`, `SLICE_BRANCH`, `OUTPUT_PATH`, `PRIOR_FINDINGS`. See feature-flow/SKILL.md "Subagent prompt envelope".

- `FEATURE-PLAN.md` at `RUN_DIR/FEATURE-PLAN.md` — find this slice's section
- `SLICE_DIR/DECOMPOSE.md` — your slice's owned files and RED test
- `RUN_DIR/slices/<m>/CONTRACT-DELTA.md` for any earlier slice that introduced contract changes (rare for harness slices)
- `CONTEXT.md` — domain vocabulary; **Test Harness** is a canonical term
- Worktree on `SLICE_BRANCH` off `SLICE_BASE`. Diff scope: `git diff <SLICE_BASE>..HEAD`.
- If `PRIOR_FINDINGS` is non-empty, address every `fail`-verdict finding.

## Mandate

Implement the harness tasks from `DECOMPOSE.md`. Your file ownership:

- **Always allowed**: anything under `tests/**`.
- **Bootstrap allowance**: when adding a new harness package to the workspace, you may also edit `pnpm-workspace.yaml` (to register the package) and the root `package.json` *scripts section only* (to add a `test:e2e` or similar entry). These edits must be listed in `DECOMPOSE.md` under owned files; if they're not, that's a decompose failure.
- **Never allowed**: any file under `apps/`, `crates/`, or `packages/`. The mock-LLM provider seam lives in Worker — Worker owns it, not you.

The Test Harness is the package whose deliverable *is* tests. Unlike the other impl agents, you don't write tests for "what you build" — your tests *are* what you build.

## TDD discipline (mandatory)

Per [`tdd`](../tdd/SKILL.md): **vertical slices, not horizontal**. Never write all tests, then all implementation. Always one test → make it green → next test.

For each behavior in this slice (often one, occasionally a small handful when the slice naturally splits):

1. **RED**: Write the smallest test that captures the behavior. Run it. Confirm it fails for the right reason (not a missing import). Commit: `test(harness): <brief, what's tested>`.
2. **GREEN**: Write the minimum harness code (fixture, helper, page object method, etc.) that makes that one test pass. Run it. Confirm it passes. Commit: `harness: <brief, what was built>`.
3. **Move on.** Don't anticipate the next test.

The git log on your branch must show alternating `test(harness):` and `harness:` commits. Reviewers will check this.

**Bootstrap-into-RED.** When this slice bootstraps the harness package itself (new `tests/e2e/package.json`, vitest/Playwright deps, `pnpm-workspace.yaml` registration, root `test:e2e` script), do **not** make a separate `harness: bootstrap` commit. Package skeleton + deps + workspace registration belong in the same commit as your first failing test. The first commit's message stays `test(harness): <brief>` and its diff contains the test, the package skeleton, the deps, and the workspace wiring. The harness package only exists to run that test.

## Steps

1. Read `SLICE_DIR/DECOMPOSE.md`. Note owned files and the slice's RED test.

2. Read the slice's section in `RUN_DIR/FEATURE-PLAN.md` for context on how this slice fits into the larger harness build-out.

3. Run the RED→GREEN cycle for the slice's behavior. Run the test framework you're building locally between cycles to catch regressions early.

4. Run gates before returning:
   - `pnpm install` (your new package likely added deps to the lockfile)
   - **If `@playwright/test` was added to deps in this slice or any prior slice and `~/.cache/ms-playwright` is empty**: run `pnpm exec playwright install chromium` (or whichever browsers `tests/e2e/playwright.config.*` declares). Without this, tests fail with "Executable doesn't exist". You can be loose here — running `playwright install` when browsers are already cached is a no-op.
   - `pnpm -C tests/e2e check` (typecheck — wire this script up if it doesn't exist as part of your work)
   - `pnpm -C tests/e2e test:e2e` (or whatever your task-list-final command is) — the slice's RED test must pass on your branch

5. Commit on the worktree branch (one `test:` and one `harness:` commit per task as above). No squash. Confirm pattern via `git log --oneline <SLICE_BASE>..HEAD` — **not** `master..HEAD`.

6. Write summary to `OUTPUT_PATH` and return it: tasks completed, RED→GREEN cycle counts, smoke test pass/fail, files added, root-config edits made (if any), prior findings addressed.

## Rules

- **File boundary.** No edits outside `tests/**` except the bootstrap allowance above (`pnpm-workspace.yaml`, root `package.json` scripts section). Touching `apps/`, `crates/`, or `packages/` is always an error. If a task seems to require it, write `BLOCKED.md` and stop.
- **Root `package.json` scope.** You may add/modify entries under `scripts`. You may not change `dependencies`, `devDependencies`, `packageManager`, `devEngines`, `private`, or anything else. If a root-level dep is needed, that's a `BLOCKED.md`.
- **`docs/adr/` is out of scope.** ADRs are planning artifacts. If your slice contradicts a consulted ADR or surfaces a new architectural decision, write `BLOCKED.md` and stop. Never author or amend an ADR from impl.
- **Don't bypass Core for product-state assertions.** When tests need to verify state, they go through the same wire a real Client does. No reading SQLite directly. No reading Vault files directly. (One exception: assertions about *Core's own startup behavior* like the `INKSTONE_LISTENING` line are fine — Core's stdout is the harness's primary discovery mechanism.)
- **No spawning Worker directly.** Worker is per-Run and Core-owned (ADR-0013). The harness only ever talks to Core; if a test needs a Worker to run, it triggers a Run through Core.
- **Mock LLM provider lives in Worker, not here.** You consume it via env vars; you don't own the implementation. If the env-var contract isn't honored, that's a Worker problem.
- **Page objects are scaffolding for future tests.** Don't over-engineer. The pattern is: one method per user-observable action (e.g., `chat.sendMessage(text)`). Selectors live in the page object, not in tests. But don't invent a deep abstraction tree before a real second test exists.
- **Tempdirs and process lifecycle.** Every fixture that spawns Core must tear it down on exit, including on test failure. Resource leaks turn into flaky CI later.

## When to fail

- A task can't be made green because the dependency in another component is missing or wrong → write `BLOCKED.md` with the specific gap.
- The smoke test is unstable (flakes) and you can't determine why → write `BLOCKED.md` rather than masking with retries.
- Required env-var contract from Worker isn't honored → `BLOCKED.md`.
