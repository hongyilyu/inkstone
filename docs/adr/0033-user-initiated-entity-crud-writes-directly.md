# User-initiated Entity CRUD writes directly; Proposals gate only the agent

/ amends [ADR-0016](./0016-proposal-application-policy.md)

ADR-0016 says "every Workspace mutation is a Proposal; one write path." That holds
for **Worker-initiated** mutations. This ADR scopes it there and adds a second
path: a **user** editing their own Library writes directly to tier 2, with no
Proposal. The user is their own approver — the Library form is the review surface
(PRODUCT.md: "the UI always makes 'what will change' legible before it changes").

## Decision

A user-initiated create/update/delete of an Entity (Person, Project, Todo, Journal
Entry, including the inline entity-ref of a Journal Entry) is applied directly:

- carried over the existing JSON-RPC channel as a new `entity/mutate` request
  (ADR-0014 reserves the `entity/*` namespace; no new transport);
- validated by the same `entities::validate` + the run-independent target checks
  the Proposal path uses;
- applied through a single shared core, `db::apply_entity_mutation`, with
  `created_by='user'` and `entity_revisions.proposal_id = NULL`.

Both paths converge on `apply_entity_mutation`. The agent path is unchanged:
`propose_workspace_mutation` → park → `proposal/decide` → `ProposalStatus::accept`
→ `apply_entity_mutation` → resolve the tool call → resume. The user path is
`entity/mutate` → validate → `apply_entity_mutation`. "One write path" is preserved
where it matters — the durable mutation — and the only fork is the Run/Proposal
bookkeeping the user path legitimately skips.

## Why direct, not a synthetic auto-approved Proposal

A `proposal` row is anchored by NOT-NULL chains to `tool_call → run → thread →
user_message`. Minting one per Library save means fabricating a fake Run scaffold
(or relaxing NOT NULL across the four most load-bearing tables), and `apply_proposal`
still does run-shaped work (resolves the tool_call with "the decision the model
reads on resume", reads `user_message_id_for_run`, park/resume + idempotency). That
is a *larger* fork than writing directly. The schema already anticipated the direct
path: `entities.created_by CHECK (... 'user')`, the `created_by='user' OR
created_via_proposal_id IS NOT NULL` exemption, and `entity_revisions.proposal_id
-- NULL only for direct user edits`.

## Consequences

- **Audit/history** for user edits lives in `entity_revisions` (proposal_id NULL) +
  `created_by='user'`, not a Proposal record. Reversal/inspection is per-revision,
  not per-Proposal.
- **Terminology.** The tier-2 record is a **Canonical Entity** (umbrella);
  **Accepted Entity** narrows to the proposal-born subset (carries
  `created_via_proposal_id`). A user-authored Entity is canonical but not accepted.
  This reconciles the older umbrella use of "Accepted Entity" in ADR-0004 (tier-2
  contents), ADR-0010 (slice-1 persistence), ADR-0014 (`entity/*` reads), and
  ADR-0016 (in-scope mutations) — those now mean Canonical Entity.
- **Provenance follows the anchor.** A plain Library create has no Message and no
  Journal-Entry anchor, so it writes no `entity_source` row (`created_by='user'` is
  the origin marker). A create from the Journal-Entry editor anchors to that JE and
  writes a `created_from` source, reusing the agent's provenance shape.
- **Manual journal edits are thread-less,** so ADR-0030's same-thread guard (which
  is keyed on a Run's Thread) does not apply to the user path; it stays on the
  agent path in `decide`.
- **Clearing an optional field** is a first-class user action the agent never
  needed. The partial-merge core gains a three-way: a key set to `null` in the
  partial removes it, any value sets it, absence preserves. This upgrades the agent
  path too (it could not clear before).
- **Delete vs. a parked Proposal.** A user can delete an Entity that a parked agent
  Proposal targets. Accepting that Proposal now maps the "apply target gone" path to
  `DecideError::NotDecidable` (`-32002`, "no longer pending"), not an opaque
  `Internal` (`-32603`), so the parked Run resolves cleanly.
- **Cross-client refresh** (`entity/changed`, specified in ADR-0014) is **deferred,
  not dropped** — single-user (ADR-0007) is served by self-invalidation (the
  mutating client refetches; agent writes refresh via the existing `proposal/changed`
  stream). Reintroduce `entity/changed` when a second concurrent Client exists.

## Considered and rejected

- **Synthetic auto-approved Proposal per user edit** — keeps ADR-0016 literally
  intact but requires a fabricated Run scaffold and still forks `apply_proposal`'s
  run-shaped work. Larger blast radius than the direct path. Rejected.
- **A new transport / URI for mutations** — violates ADR-0014 ("there is no second
  transport"; REST+WebSocket hybrid explicitly rejected). Rejected.
- **`relation='user_created'` provenance row** with null source columns — needs a
  CHECK-relaxing migration for a row that points nowhere; `created_by='user'`
  already records origin. Rejected.
