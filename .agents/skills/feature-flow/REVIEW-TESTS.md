# REVIEW-TESTS.md (SOP for the tests reviewer)

You are the tests reviewer for one slice. Read-only on source, but you DO run gate scripts and inspect git history.

## Mandate

For *this slice*, three questions:
1. Do the gate scripts pass on the slice branch?
2. Does the slice's RED test exist and exercise the behavior the slice promised?
3. Does the git log show TDD discipline — alternating `test:` and impl commits — for components with test infrastructure?

## Inputs

- Worktree of `flow/<slug>/slice-<n>` (your own, isolated)
- `FEATURE-PLAN.md` — find this slice's section
- `slices/<n>/DECOMPOSE.md` — slice's component(s), files, RED test
- The slice's diff: `git diff <slice-base>..<slice-branch>`
- The slice's commits: `git log --oneline <slice-base>..<slice-branch>`

## Steps

1. **Run gates on the slice branch.** Capture pass/fail per command:

   - `pnpm install --frozen-lockfile` if `pnpm-lock.yaml` changed in the diff
   - `pnpm check` — workspace typecheck + Rust check
   - **Run every command in `SLICE_DIR/DECOMPOSE.md`'s "Test commands" section.** Authoritative — do not guess script names like `test`. The slice's own RED test runs via whatever the decomposer enumerated.
     - If any command's package depends on `@playwright/test`, run `pnpm exec playwright install chromium` first (idempotent — no-op if browsers are cached).
   - Cross-check: if the slice diff touches a Rust crate AND that crate has tests at `<SLICE_BASE>` or after the slice (`<crate>/tests/*.rs` OR `#[test]`/`#[cfg(test)]` in `<crate>/src/`) AND the DECOMPOSE.md "Test commands" didn't enumerate a `cargo test` for it — flag as a finding (decompose miss). Don't run the missing command yourself; that's what the decomposer is for.

2. **Slice RED test exists and exercises the behavior.** Find the test file(s) added or modified in this slice. Confirm:
   - The slice's stated behavior (from `DECOMPOSE.md` and `FEATURE-PLAN.md`) is reflected in at least one test assertion.
   - The test uses the public interface of the affected component, not internal hooks.
   - The test would fail without the slice's impl changes (verify by reading; you don't need to actually revert and re-run).

3. **TDD commit pattern.** Run `git log --oneline <SLICE_BASE>..HEAD` and inspect commits.

   **Feature-scope exception (`SLICE: feature`):** `feature/<slug>` carries one squashed commit per slice, so there is no RED→GREEN sequence to inspect here — it was already verified per slice in phase 4 on each scratch branch. Skip this entire step; assert gates (step 1) and coverage (step 4) only.

   **Per-component subsequence, not whole-slice alternation.** When a slice touches two components, the log will interleave by spawn order, not strict alternation. Group commits by their prefix (`test(core):`/`core:` together, `test(ui):`/`ui:` together, etc.) and check the *subsequence* for each component, not the merged stream.

   For each component's subsequence, the expected pattern is alternating `test(<comp>):` / `<comp>:` commits, with the first usually being `test(<comp>):` (the RED).

   **Carve-out (skip RED allowed):** ALL of these must hold for the carve-out to apply:
   1. The component's package had no test infrastructure when the slice started, AND
   2. The slice's plan section does **not** itself bootstrap that infrastructure, AND
   3. The impl agent's return summary documented the carve-out invocation.

   Bootstrap evidence: check `package.json`, `Cargo.toml`, and conventional test directories (`tests/`, `__tests__/`, `src/**/*.test.*`) at `<SLICE_BASE>` — that's the parent state. If the slice's diff *adds* test infra (a new `test` script, a new `tests/` dir with `*.rs`, a new `__tests__/`), then the slice IS the bootstrap and the carve-out does **not** apply — the slice must contain a RED test for the bootstrap to be meaningful.

   **Bootstrap-into-RED rule (when the slice bootstraps test infra):** dependency adds (vitest, playwright, cargo dev-deps), test-runner config (`vitest.config.ts`, `playwright.config.ts`), and the `test` script in `package.json` are *part of* the RED commit — they exist only to make the failing test runnable. Expect the first commit on the slice to be `test(<comp>): <brief>` whose diff includes both (a) the failing test file and (b) the runner config / dep-add / script. A separate `<comp>: bootstrap vitest` commit before the RED is a TDD violation — flag it.

   **Refactor-slice exemption:** If the slice's plan section explicitly describes a refactor (no new behavior, only restructuring) AND the slice's RED test is "the existing test still passes against the new shape," then a single combined `test(<comp>): use new shape` + `<comp>: extract new shape` is acceptable. Check the plan's slice description for "refactor" / "extract" / "rename" language. Don't apply this exemption based on the diff alone — the plan must declare it.

4. **Coverage proportionality (where infra exists).** If the slice's component has test infra:
   - The slice's RED test counts as one. If the slice's behavior has multiple branches and only one is tested, flag.
   - Don't demand exhaustive coverage. Inkstone biases toward minimum tests that prove the change.

5. **Don't fail for missing tests in packages with no test infra.** Note as `advisory`.

## Output

Write `slices/<n>/REVIEWS/<iteration>/tests.md`:

```md
# Tests review — slice <n>, iteration <m>

Verdict: pass | fail | advisory

## Gates

| Command | Status | Notes |
|---|---|---|
| pnpm check | pass/fail | ... |
| pnpm -C <pkg> test | pass/fail/skipped | ... |
| cargo test (core) | pass/fail/skipped | ... |

## Slice RED test

- Location: `path/to/test.ext:test name`
- Exercises slice behavior: yes/no
- Uses public interface: yes/no
- Would fail without impl: yes/no

## TDD commit pattern

For each component this slice touched:

- {{component}}: subsequence = test → impl → test → impl | impl-only | mixed
  - Carve-out applies? yes/no — must satisfy: parent had no infra AND slice doesn't bootstrap AND agent declared
  - Refactor exemption applies? yes/no — must be declared in plan slice section
  - Verdict for this component: ok | violated

## Findings

### {{title}}
- {{specific finding tied to file:line or commit hash}}
```

## Verdict rules

- `fail` — any gate failed.
- `fail` — slice's RED test missing entirely (and infra exists).
- `fail` — TDD commit pattern violated and carve-out doesn't apply.
- `advisory` — minor concerns: slow gates, fragile-looking test, partial branch coverage.
- `pass` — gates green, slice test present and on the public interface, commit pattern consistent with TDD or carve-out.

**Never fail a slice for "no test infra exists in this package"** if it's a pre-existing condition the slice didn't promise to fix.
