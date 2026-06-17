# Git hooks

Shared, committed hooks. Enable once per clone:

```
git config core.hooksPath .githooks
```

## pre-push

Before any push of a feature branch (skipped on `master`), blocks unless:

1. **Rebase-current** — branch contains the tip of `origin/master` (else: `git rebase origin/master`).
2. **Commit-subject format** — every commit since `origin/master` matches
   `verb(module): description` (`verb` ∈ feat|fix|refactor|docs|test|chore). The PR title derives from these.
3. **Local CI** — the full CLAUDE.md §6 gate passes: `pnpm lint`, `pnpm check`, `pnpm -r test`, `cargo test`.

Emergency bypass: `git push --no-verify` (don't).
