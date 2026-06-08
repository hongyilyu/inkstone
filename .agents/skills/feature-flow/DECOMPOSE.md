# DECOMPOSE.md (per-slice SOP)

Run this once **per slice**, in slice phase 1. The orchestrator runs it directly — no subagent.

## Goal

For *this slice*, confirm exactly what changes: which component owns it, which files it touches, whether the contract changes, and what the slice's RED test will be.

The high-level slice-level decomposition (which slices exist, their order, their behaviors) was already done in the intake phase and lives in `FEATURE-PLAN.md`'s `## Slices` section. **Don't re-decompose at the feature level here.** Trust the plan.

## Steps

1. Read `FEATURE-PLAN.md`'s `## Slices` section. Find the slice you're decomposing.

2. Read prior slices' `slices/<m>/DECOMPOSE.md` (where `m < n`). The current slice may depend on files those slices touched; you need to know what's already there before allocating ownership.

3. Confirm the slice's component(s). File allocations cover *each component's whole package directory*, including tests and config (Cargo.toml / package.json), not just `src/`:
   - **Core**: `crates/core/**` (includes `crates/core/src/**`, `crates/core/tests/**`, `crates/core/Cargo.toml`)
   - **Worker**: `packages/worker/**`
   - **UI**: `apps/web/**`, `packages/ui-sdk/**`
   - **Harness**: `tests/**`, plus a narrow allowance for root `pnpm-workspace.yaml` and root `package.json` *scripts only* — see IMPL-HARNESS.md
   - **Contract** (always shared if touched): `packages/protocol/**`

   Most slices touch one component. Some touch two. If the plan says one and you find evidence of two, write the disagreement to `slices/<n>/OPEN-QUESTIONS.md` and continue with the most defensible single-component reading.

4. Allocate files to *this slice*. Rules:
   - Each file is owned by one component within the slice.
   - `packages/protocol/**` is owned by the contract phase.
   - Files modified by earlier slices may be modified again here — flag this so the impl agent knows it's editing not creating.
   - Don't claim a file the slice doesn't actually need.

5. Confirm contract delta (yes / no, and if yes, what). The plan should already say. If the slice section is silent, default to no.

6. Restate the slice's RED test. The plan provides the behavior; transcribe it as a one-line test description the impl agent will turn into actual code.

7. Write `slices/<n>/DECOMPOSE.md` to the run directory, using the template below.

8. Append `slice-<n>-decomposed` to `STATE.md`.

## Per-slice DECOMPOSE.md template

```md
# Slice <n> decomposition: {{slice title}}

Base: feature/<slug> tip (slice-<n-1>'s squashed commit, or master for slice-1)
Scratch branch: flow/<slug>/slice-<n>

## Component

- {{Core | Worker | UI | Harness}} (one of these is primary)
- (Optional) Secondary: {{...}} — note that this requires a sequential second impl pass after the first lands
- (Optional) Order: {{primary-first | secondary-first}} — required when secondary exists; the *producer* of any cross-component dependency goes first

## Owned files

- `path/to/file.ext` — {{new | modified-this-slice | modified-by-slice-<m>-and-again-here}}

## Contract delta

- {{No change.}} OR
- {{Specific additions/changes to packages/protocol}}

## Slice RED test

Behavior to prove (transcribed from FEATURE-PLAN.md slice <n>):
> {{one-line description}}

Where the test lives:
- `path/to/test.ext` (the impl agent decides exact name; this is the directory)

## Test commands

Commands the verify phase and REVIEW-TESTS must run for this slice. Each entry is `<scope>: <pnpm/cargo command>`. Include only the commands that exercise *this slice's* affected packages — not the whole workspace (workspace typecheck is `pnpm check`, separate).

- `<package or crate name>: <command>`

Examples:
- `@inkstone/worker: pnpm -C packages/worker test`
- `tests/e2e: pnpm -C tests/e2e test:e2e`
- `crates/core: cargo test --manifest-path crates/core/Cargo.toml`

If the slice's affected packages have no test commands (e.g., placeholder UI bundle with no test infra), write `(none)` and the verify/review phases will skip per-package tests for this slice.

## Cross-slice notes

- (Optional) Files this slice modifies that earlier slices also touched.
- (Optional) New types from contract phase that the impl will consume.
```

## Failure modes

- **Slice ownership conflicts with the plan.** Plan says one component; the work clearly needs another. Write `slices/<n>/BLOCKED.md` and stop the flow — the slice is mis-planned, not just mis-decomposed.
- **Slice can't be made vertical.** The slice's RED test would require code from a future slice to compile/pass. The plan ordered the slices wrong. `BLOCKED.md`, stop.
- **File overlap with an earlier slice (already squashed onto `feature/<slug>`) that breaks the earlier slice's behavior.** Earlier slice's tests would fail. `BLOCKED.md`, stop.
