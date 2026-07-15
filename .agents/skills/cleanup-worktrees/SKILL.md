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
2. Classify each remaining worktree's branch:
   - `gh pr list --head <branch> --state all --json state -q '.[0].state'` → `MERGED`/`CLOSED` = stale; `OPEN` = keep, always.
   - No PR: stale only if `git log master..<branch> --oneline` is empty. This repo squash-merges — NEVER use `git branch -d` or merge-base as the merged test; PR state is the truth. No PR + unique commits = keep, list it for the user.
3. Delete stale ones: `git worktree remove --force <path>` then `git branch -D <branch>`. Don't fall back to `rm -rf`.
4. Finish: `git worktree prune`, then also delete any branchless leftovers the same way (`flow/*`, `worktree-*` branches whose PR is merged/closed, step-2 rules). Print: `removed N worktrees / M branches; kept K (open PR: ..., unique commits: ...)`.

Never touch `master`, the main checkout, or any branch with an open PR.
