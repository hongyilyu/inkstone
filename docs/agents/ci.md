# CI: GitHub Actions

`.github/workflows/ci.yml` runs the full [AGENTS.md §6](../../AGENTS.md) quality
gate on every push to `master` and every pull request. It is pure wiring of the
existing hermetic suite — no test or product code runs in CI that you can't run
locally with the §6 commands.

## Jobs

Four parallel jobs, each a required status check. Names are stable on purpose —
branch protection keys off them (see below).

| Job | §6 gate | Command |
|---|---|---|
| `lint-format` | format + lint | `biome ci .` |
| `ts` | check (TS) + vitest | `pnpm -r --if-present check` then `pnpm -r test` |
| `rust` | check (Rust) + cargo test | `cargo check`/`cargo test` on `crates/core` |
| `e2e` | hermetic e2e | `pnpm test:e2e` |

## Non-obvious decisions

- **`biome ci .`, not `pnpm format`.** `pnpm format` is `biome format --write .`,
  which *mutates* files — wrong for a gate. `biome ci .` is read-only and fails on
  any format, lint, **or** `organizeImports` diagnostic, covering both §6 biome
  gates in one pass.

- **The `rust` job installs Node deps.** The `crates/core` integration tests spawn
  TypeScript worker fixtures through `packages/worker/node_modules/.bin/tsx`
  (`tsx_bin()` panics if absent). So `cargo test` needs a full `pnpm install`
  first — it is not a TS-only concern.

- **No `DATABASE_URL` / `SQLX_OFFLINE`.** `crates/core` uses only runtime sqlx
  query functions and `sqlx::migrate!` (expanded from `crates/core/migrations/`).
  There are no compile-time `query!` macros, so nothing needs a live DB or an
  `.sqlx` cache to compile.

- **`strictDepBuilds: false` in `pnpm-workspace.yaml`.** pnpm 11 aborts a
  non-interactive install with `ERR_PNPM_IGNORED_BUILDS` when a dependency ships
  an un-approved build script. `onlyBuiltDependencies` alone does **not** suppress
  this (verified on 11.2.2). `strictDepBuilds: false` downgrades it to a warning
  so `pnpm install --frozen-lockfile` succeeds, while the allowlist still scopes
  which deps actually run scripts — no `--dangerouslyAllowAllBuilds`, no
  build-script widening.

- **e2e shares the `rust` cargo cache** via `Swatinem/rust-cache` `shared-key: core`
  (the harness builds a debug Core in `globalSetup`). Playwright's Chromium is
  cached separately, keyed on the lockfile; OS libraries are reinstalled each run
  because they live outside the cached browser dir.

- **Pins live only in the workflow** (Node 24, pnpm 11.2.2, Rust stable). There is
  no `.nvmrc`/`packageManager` field, so bump these deliberately.

## Branch protection

The four checks are required to merge into `master`. They must have reported once
(open a PR / push a commit so all four run) before the API will accept them. Needs
a token with repo admin.

```sh
gh api -X PUT repos/hongyilyu/inkstone/branches/master/protection \
  -H 'Accept: application/vnd.github+json' \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "checks": [
      { "context": "lint-format" },
      { "context": "ts" },
      { "context": "rust" },
      { "context": "e2e" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

`strict: true` requires a branch to be up to date with `master` before merging.
Verify with:

```sh
gh api repos/hongyilyu/inkstone/branches/master/protection/required_status_checks \
  --jq '.checks[].context'
```

If you rename a job, re-run the PUT — a renamed job silently stops matching its
required check. Don't convert these jobs to a matrix without updating the contexts
(a matrix changes the context to `job (value)`).
