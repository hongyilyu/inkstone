---
name: cleanup-worktrees
description: >-
  Sweep stale agent worktrees and dead local branches after feature-flow /
  review-loop runs. Removes each .claude/worktrees entry (and its local
  branch) whose PR is merged or closed — never an open-PR branch, a locked
  worktree, or the worktree the session is running in. Use when the user
  says "cleanup worktrees" / "/cleanup-worktrees" or stale worktrees have
  piled up.
---

# /cleanup-worktrees

From the main checkout root (`git worktree list` first line), classify then delete. Never ask per-item; report one summary at the end.

1. Inventory: `git worktree list --porcelain`. Skip the main checkout, any entry marked `locked`, and the worktree containing `$PWD`.
2. Classify each remaining worktree:
   - Detached (no `branch` line in the porcelain entry): no branch to classify or delete — stale only if its tree is clean; remove by path (step 3, skipping the branch deletion).
   - `gh pr list --head "$branch" --state all --json state --jq 'map(.state)'` → contains `OPEN` = keep, always; all `MERGED`/`CLOSED` = stale. `gh` errored or returned nothing parseable ⇒ fail closed: keep, list it for the user. (A branch can have several PRs; never read just the first entry.)
   - No PR at all: stale only if `git log "master..$branch" --oneline` is empty. This repo squash-merges — NEVER use `git branch -d` or merge-base as the merged test; PR state is the truth. No PR + unique commits = keep, list it for the user.
3. Delete stale ones:
   - Skip and report any worktree whose `git -C "$path" status --porcelain` is non-empty — `git worktree remove --force` would destroy uncommitted work.
   - `git worktree remove --force -- "$path"` then `git branch -D -- "$branch"` (skip the branch step for detached entries). Don't fall back to `rm -rf`.
4. Finish: `git worktree prune`, then sweep worktree-less local branches the same way (`flow/*`, `worktree-*` branches whose PR is merged/closed, step-2 rules). Print: `removed N worktrees / M branches; kept K (open PR: ..., unique commits: ..., dirty: ...)`.

Never touch `master`, the main checkout, or any branch with an open PR.
