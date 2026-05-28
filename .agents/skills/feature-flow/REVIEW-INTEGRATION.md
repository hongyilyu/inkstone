# REVIEW-INTEGRATION.md (SOP for the integration reviewer)

You are the integration reviewer for **one slice**. Read-only. Parallel with other reviewers.

## Mandate

Inkstone is split into components communicating via two protocols. You verify the seams hold *for changes in this slice*:

- **Tool Protocol** (Worker ↔ Core, bidirectional, ADR-0003): Every Tool Request has a matching Tool Result handler. Types align on both sides.
- **Run Events** (Worker → Core, one-way, ADR-0006): Worker emits, Core consumes/persists/forwards. No `await` on the Worker side.
- **Wire Protocol** (Client ↔ Core, ADR-0014): Clients call Core only. No Client touches the DB, Vault, Worker, or LLM providers.

## Inputs

The orchestrator passes a prompt envelope at the top: `SLUG`, `SLICE`, `ITERATION`, `RUN_DIR`, `SLICE_DIR`, `SLICE_BASE`, `SLICE_BRANCH`, `OUTPUT_PATH`. See feature-flow/SKILL.md "Subagent prompt envelope".

- Worktree on `SLICE_BRANCH`.
- The slice diff: `git diff <SLICE_BASE>..HEAD`.
- `RUN_DIR/slices/<m>/CONTRACT-DELTA.md` for any earlier slice that introduced contract changes (those types may be consumed in *this* slice's diff even if the slice itself didn't change them).
- `SLICE_DIR/CONTRACT-DELTA.md` if this slice introduced contract changes.
- ADRs 0001, 0002, 0003, 0006, 0014 — read them when the slice diff touches their concerns.

## Steps

1. Identify protocol-relevant changes in the slice diff. If the diff touches none of the seams above, this is a no-op slice for you — return `pass` with a "no protocol-relevant changes" note. Don't manufacture findings.
2. List protocol changes from contract deltas (this slice's or earlier-slice's, whichever the diff consumes).
3. For each new/changed type, find both ends within the diff or its references:
   - **Producer**: who emits / sends / writes the type
   - **Consumer**: who receives / handles / reads it
   Confirm both exist and agree on shape.
4. Spot-check that no ADR-banned access pattern slipped in *in this slice's diff*:
   - Client code reaching into `crates/core/src/db.rs` directly? Fail.
   - Worker writing to SQLite? Fail.
   - Worker calling the Vault filesystem? Fail.
   - UI making LLM calls? Fail.
5. Run-event sanity: any `await` on a Run Event emit added in this slice? Fail.
6. Tool-protocol sanity: any Tool Request added without a corresponding handler in this slice (or expected to be present from earlier slices/contract)? Fail.

## Output

Write to `OUTPUT_PATH` (`SLICE_DIR/REVIEWS/<ITERATION>/integration.md`):

```md
# Integration review — slice <SLICE>, iteration <ITERATION>

Verdict: pass | fail | advisory

## Slice protocol relevance

- {{none — slice doesn't touch Tool Protocol, Run Events, or wire types}} OR
- {{summary of which seam(s) this slice touches}}

## Protocol changes

- {{type}}: producer = {{file:line}}, consumer = {{file:line}}
- ...

## Boundary violations

- {{none}} OR
- {{file:line — Client touches DB; ADR-0002 violated}}

## Findings

### {{title}}
- Concern: {{...}}
- ADR: {{0001/0002/0003/0006/0014, where applicable}}
```

## Verdict rules

- `fail` — any boundary violation, missing producer/consumer, or async/sync mismatch on Run Events introduced in this slice.
- `advisory` — style concerns, like a slightly awkward but functional handler.
- `pass` — all seams aligned, or slice is not protocol-relevant.
