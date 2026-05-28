# IMPL-CORE.md (SOP for the Core impl subagent)

You are the Core impl agent. You own `crates/core/**` for this run. Parallel with the Worker and UI agents.

## Inputs

The orchestrator passes a prompt envelope at the top of your prompt. Read these fields before anything else: `SLUG`, `SLICE`, `ITERATION`, `RUN_DIR`, `SLICE_DIR`, `SLICE_BASE`, `SLICE_BRANCH`, `OUTPUT_PATH`, `PRIOR_FINDINGS`. See feature-flow/SKILL.md "Subagent prompt envelope".

- `FEATURE-PLAN.md` at `RUN_DIR/FEATURE-PLAN.md` — find this slice's section
- `SLICE_DIR/DECOMPOSE.md` — this slice's owned files and RED test (per-slice DECOMPOSE.md is single-component; you are the component)
- `RUN_DIR/slices/<m>/CONTRACT-DELTA.md` for any earlier slice that introduced contract changes (rare — usually absent)
- `CONTEXT.md` at the repo root — domain vocabulary
- Your worktree is checked out to `SLICE_BRANCH`, branched off `SLICE_BASE`. The diff scope for this slice is `git diff <SLICE_BASE>..HEAD`.
- If `PRIOR_FINDINGS` is non-empty, read each path — those are the failing reviewer outputs from the previous iteration. Address every `fail`-verdict finding.

## Mandate

Implement this slice per `SLICE_DIR/DECOMPOSE.md`. **Only** edit files listed under "Owned files" in that file. Touching another component's files is an error.

## TDD discipline

Per [`tdd`](../tdd/SKILL.md): **vertical slices, not horizontal**. For each task, write one test, make it pass, then move on. Don't write all tests up front; don't anticipate future tests.

For each task:

1. **RED**: Write the smallest test for the behavior. Run it. Confirm it fails for the right reason. Commit: `test(core): <slug> — <brief>`.
2. **GREEN**: Minimum code to pass. Run it. Confirm green. Commit: `core: <slug> — <brief>`.
3. Move on.

The git log must show alternating `test(core):` and `core:` commits. The tests reviewer will check this.

**Carve-out: test infrastructure missing.** All three must hold for the carve-out to apply:

1. `crates/core` has no test infrastructure at `SLICE_BASE` (no `tests/*.rs`, no `#[test]`/`#[cfg(test)]` in `src/`, no test dev-deps in `Cargo.toml`).
2. **The slice's plan section does not itself bootstrap infrastructure.** If your owned files include a new `tests/*.rs` or new test deps in `Cargo.toml`, the slice IS the bootstrap — carve-out does **not** apply, you must run RED→GREEN. The bootstrap is in service of the slice's RED test.
3. You document the carve-out invocation in your return summary so the reviewer can verify.

If the carve-out applies, you may skip RED and only commit GREEN. Otherwise, run RED→GREEN normally. Prefer to bootstrap a minimal test setup if the plan doesn't forbid it — the friction is small and the long-term cost of test-less code is large.

**Bootstrap-into-RED.** When this slice bootstraps Rust test infra (adding dev-deps to `Cargo.toml`, creating `crates/core/tests/`), do **not** make a separate "bootstrap" commit. The dep-adds and the new `tests/` setup belong in the same commit as your failing test, because that's why they exist. The first commit's message stays `test(core): <brief>` and its diff contains both the test file and the `Cargo.toml` change.

## Steps

1. Read `SLICE_DIR/DECOMPOSE.md` end-to-end. Note owned files and the slice's RED test.

2. Read any upstream `RUN_DIR/slices/<m>/CONTRACT-DELTA.md` if present. Understand what types you must produce or consume.

3. Run the RED→GREEN cycle for the slice's behavior (or GREEN-only with the carve-out above). Use `DECOMPOSE.md`'s "Slice RED test" description as the test's behavioral target.

4. Run the Core gates before returning:
   - `cargo check --manifest-path crates/core/Cargo.toml` (matches root `package.json`'s `check:rust`)
   - `cargo test --manifest-path crates/core/Cargo.toml` if **any** of: `crates/core/tests/` has `*.rs` files (integration tests), or `crates/core/src/` contains `#[test]`/`#[cfg(test)]` (unit tests). When in doubt, run it — `cargo test` is a no-op if there's nothing to discover, but skipping a slice that just added an integration test would silently ship a broken slice.
   - Stop and fix if either fails.

5. Confirm the commit pattern: `git log --oneline <SLICE_BASE>..HEAD` should show your RED→GREEN sequence on this slice only (or GREEN-only with the carve-out documented in your return summary). Do **not** use `master..HEAD` — that includes prior slices' commits and will produce a misleading log.

6. Write the return summary to `OUTPUT_PATH` (also return it in your final message): files edited, RED→GREEN cycles run (or GREEN-only with reason), gates that passed, drift from plan, prior findings addressed (if any).

## Rules

- **File boundary is a hard rule.** Do not edit `packages/worker/**`, `packages/protocol/**`, `apps/web/**`, `packages/ui-sdk/**`. If you think you need to, that's a decompose failure — write to `BLOCKED.md` in the run directory and stop.
- **`docs/adr/` is out of scope.** ADRs are planning artifacts. They land during intake, before the slice loop starts. If your slice's behavior contradicts a consulted ADR or surfaces a new architectural decision that should be recorded, that's a planning miss — write `BLOCKED.md` describing the conflict and stop. **Never** author or amend an ADR from impl.
- **Domain vocabulary.** Use the canonical terms from `CONTEXT.md`. If you find yourself reaching for an "Avoid" term, the boundary is leaking — stop and re-read the relevant ADR.
- **Storage tier discipline.** Tier 1 = Vault files, tier 2 = canonical SQLite, tier 3 = projections. Don't write user-authoritative content to tier 2 or projections. Don't read tier 3 as if it were authoritative.
- **Snapshots, not raw events.** If watcher logic is involved, build on Snapshot + hash, not raw FS events (ADR-0005).
- **Run lifecycle is Core-owned.** Worker drives Turns; Core owns Run state and persistence (ADR-0012).

## When to fail

- Required contract type missing or wrong shape → write `BLOCKED.md`, do not work around it.
- Task verify check can't be made true with edits inside Core's file ownership → write `BLOCKED.md`.
- A change would contradict an ADR → write `BLOCKED.md` and surface which ADR.
