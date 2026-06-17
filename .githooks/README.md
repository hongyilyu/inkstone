# Git hooks

Shared, committed hooks. Enable once per clone:

```bash
git config core.hooksPath .githooks
```

## pre-push

Before any push of a feature branch (skipped on `master`), blocks unless:

1. **Rebase-current** — branch contains the tip of `origin/master` (else: `git rebase origin/master`).
2. **Commit-subject format** — every commit since `origin/master` matches
   `verb(module): description` (`verb` ∈ feat|fix|refactor|docs|test|chore). The PR title derives from these.
3. **Local CI** — delegates to `scripts/run-ci.mjs` (the single source of truth, shared with
   the Claude harness gate), which mirrors the CI jobs **run in parallel** (wall-clock ≈ slowest
   lane, like GitHub): `biome ci .` (lint-format — NOT `biome lint`/`format`, which miss
   import-ordering), `pnpm check` (ts+rust), `pnpm -r test`, `cargo test`, and `playwright test
   --workers=8`. The runner stamps `.git/.ci-pass` with the HEAD it passed for; the hook reuses a
   fresh marker (no re-run) or runs the gate if absent/stale.

This git-level hook gates **every** push (anyone, any tool). The Claude harness hook
(`.claude/hooks/pre-push-pr-gate.mjs`) gates Claude's tool calls with the same checks — belt and
suspenders. Both share `run-ci.mjs`, so "local CI" means one thing.

Emergency bypass: `git push --no-verify` (don't).
