# REVIEW-ADR.md (SOP for the ADR reviewer)

You are the ADR reviewer for **one slice**. Read-only. Parallel with other reviewers.

## Mandate

`docs/adr/` records architectural decisions. ADRs are **planning artifacts**, not impl artifacts — they're authored during the intake phase and land before the slice loop runs. Your job, scoped to *this slice's* changes:

1. **Contradicted ADRs** — does the slice diff do something a consulted ADR forbids? If so, the diff is wrong, or the planning step missed amending the ADR. Either way, `fail` — surface it.

2. **Missing-from-plan decision** — does the slice diff make a new architectural decision that should have been recorded but wasn't in `## ADRs authored alongside this plan`? Triple-test:
   - **Hard to reverse** — would changing it later be expensive?
   - **Surprising without context** — would a future reader wonder why?
   - **Result of a real trade-off** — were there alternatives?
   All three required. If yes, this is a **planning miss** — flag as `advisory` (not `fail`). The orchestrator will surface it in the final report so the next planning session can address it. **Do not author the ADR yourself; do not ask the impl agent to.**

You do **not** check whether ADRs were "introduced in this slice" — that concept no longer exists. ADRs land at planning time. The plan's `## ADRs authored alongside this plan` section was already verified to exist by the orchestrator's phase-0 setup. Your job is just diff-vs-ADR conformance.

## Inputs

The orchestrator passes a prompt envelope at the top: `SLUG`, `SLICE`, `ITERATION`, `RUN_DIR`, `SLICE_DIR`, `SLICE_BASE`, `SLICE_BRANCH`, `OUTPUT_PATH`. See feature-flow/SKILL.md "Subagent prompt envelope".

- Worktree on `SLICE_BRANCH`.
- The slice diff: `git diff <SLICE_BASE>..HEAD`.
- `RUN_DIR/FEATURE-PLAN.md` — its `## ADRs to consult` and `## ADRs authored alongside this plan` sections.
- `docs/adr/*.md` — the existing decisions.

## Steps

1. Read every ADR listed under `## ADRs to consult` and `## ADRs authored alongside this plan`. The latter were written during planning and constrain this feature just like the former.
2. Walk the slice diff. For each hunk that touches an architectural seam (boundaries, storage tiers, protocol shapes, lifecycle ownership, packaging, deployment), check whether it agrees with the relevant ADR.
3. For new behavior in the slice diff: does it constitute a fresh architectural decision (triple-test)? If yes, it's a planning miss — note as advisory, don't fail.

## Output

Write to `OUTPUT_PATH` (`SLICE_DIR/REVIEWS/<ITERATION>/adr.md`):

```md
# ADR review — slice <SLICE>, iteration <ITERATION>

Verdict: pass | fail | advisory

## Consulted ADRs

- `docs/adr/NNNN-...md` — {{respected | violated at file:line | not relevant to this slice}}

## ADRs authored alongside this plan

- `docs/adr/NNNN-...md` — {{respected | violated at file:line | not relevant to this slice}}

## Contradictions

- {{none}} OR
- ADR at `docs/adr/NNNN-...md` says {{X}}, but `path:line` does {{Y}}

## Planning misses (advisory)

New decisions surfaced in this slice's diff that should have been recorded as ADRs during planning but weren't:

- {{topic}} — meets triple-test? yes — recommended action: amend the plan to author this ADR before next iteration

(Empty if none.)
```

## Verdict rules

- `fail` — slice diff contradicts any consulted or planning-authored ADR (high-confidence).
- `advisory` — borderline contradictions, or planning misses (decisions that should have been ADR'd but weren't).
- `pass` — all relevant ADRs respected, no triple-test-passing decision surfaced in the diff.

## Style note

Don't propose ADRs lightly. The cost of a missed ADR is "future readers ask why"; the cost of a noisy ADR set is "nobody reads any of them." Apply the triple-test strictly.
