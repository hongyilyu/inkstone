# Manual Entity & Journal CRUD from the Library

## Goal

Let the user create, edit, and delete Entities (Person, Project, Todo, Journal
Entry) directly from the Library page — the same CRUD the agent does today via
Proposals, but user-initiated and applied without an approval step.

Success: from the Library, the user can add a new Todo/Person/Project/Journal
Entry, edit any field of an existing one, manage Todo↔Person/Project links and
Journal-Entry body refs, and delete — each landing in tier-2 atomically and
reflected live, with no Proposal in the loop.

## Decision: user writes directly; Proposals gate the agent

ADR-0016 ("every Workspace mutation is a Proposal; one write path") describes the
**agent's** write path. A user editing their own Library is their own approver —
the form *is* the review surface (PRODUCT.md: "the UI always makes 'what will
change' legible before it changes"). User mutations write directly.

This is what the schema was built for, not a workaround:

- `entities.created_by CHECK (created_by IN ('user','proposal'))` — `'user'` is a
  first-class origin.
- `CHECK (created_by='user' OR created_via_proposal_id IS NOT NULL)` — a user row
  is explicitly exempt from carrying a `proposal_id`.
- `entity_revisions.proposal_id ... -- NULL only for direct user edits (none in
  slice 1)` — the edit-history record already reserves this case.

Synthetic auto-approved Proposals were considered and rejected: a `proposal`
requires a `tool_call` (NOT NULL UNIQUE) → a `run` (NOT NULL) → a `thread` +
`user_message` (NOT NULL). Minting one per Library edit means fabricating a fake
Run scaffold (or relaxing NOT NULL across the four most load-bearing tables), and
`apply_proposal` still does run-shaped work (resolves the tool_call with "the
Decision the model reads on resume", reads `user_message_id_for_run`, park/resume
+ idempotency). That is a *larger* fork than writing directly.

**"One write path" is preserved at the seam that matters:** both the agent path
and the user path converge on a single extracted `db::apply_entity_mutation`. The
fork is exactly the bookkeeping we *want* to skip (proposal row, tool_call
resolution, park/resume). Audit/history holds via `entity_revisions`
(`proposal_id` NULL) + `created_by='user'`.

## Mental model

```text
AGENT path (unchanged):
  Worker → propose_workspace_mutation {mutation_kind, payload}
         → park → proposal/decide → decide::apply
                                       ├─ ProposalStatus::accept (flip)
                                       ├─ db::apply_entity_mutation  ◀── shared core
                                       └─ resolve_tool_call + resume

USER path (new):
  Library form → entity/mutate {mutation_kind, payload}
              → mutate::apply
                   ├─ entities::validate            ◀── reused verbatim
                   ├─ shared target validation      ◀── reused (run-independent part)
                   └─ db::apply_entity_mutation      ◀── shared core (created_by='user')
                        → entity/changed notification
```

The wire envelope for `entity/mutate` is the *same* `{mutation_kind, payload}`
discriminated union the Worker's `propose_workspace_mutation` tool already uses
(minus `rationale`). Same validators, same apply core.

## UI surface: inline in the right rail

Reuse the existing three-region `WorkspaceShell`; add no modal/overlay primitive
(the app has none, and PRODUCT.md's anti-references reject "cluttered
power-tools / everything visible at once").

- `EntityDetail` (the right-rail inspector) gains a **view ↔ edit** toggle.
- A **"New {Kind}"** action in each `EntityCollection` header opens a blank entity
  in the rail in edit mode.
- **Delete** is an inline footer confirm in the rail ("Delete this Todo? Cancel /
  Delete") — destruction stays legible.
- The **Journal Entry body editor** (text + entity-ref chips) gets an **expanded
  rail width**, since chip editing is cramped at the default ~rail width.

## Slices

Each slice ends green on the CI gate (`pnpm format` on changed files, `pnpm lint`,
`pnpm check`, `pnpm -r test`, `cargo test`).

### Slice 0 — Core: extract `apply_entity_mutation` (no behavior change)

Refactor `db::apply_proposal` so the run-independent entity work becomes a new
`db::apply_entity_mutation(&mut tx, spec)` taking **no** `run_id`/`tool_call_id`.
Everything between the proposal-flip and `resolve_tool_call` moves in: per-kind
data payload (`entity_data_payload`), insert/update/delete + revision, `create_todo`
person_refs, `update_todo` in-tx merge, `delete_project` cascade, the
`reference_*` body rewrite, the `update_journal_entry` body-ref ownership check.

The one run-coupled bit — `entity_sources` message sourcing via
`user_message_id_for_run` — is lifted to the caller: `apply_entity_mutation` takes
an already-resolved `Option<EntitySourceSpec>` (proposal path resolves the user
Message; the new user path passes a Journal-Entry source or `None`).

`apply_proposal` becomes: `ProposalStatus::accept` → `apply_entity_mutation(spec
with created_by='proposal', proposal_id, source=resolved-message-or-JE)` →
`resolve_tool_call`.

- **Reference-mutation reuse — CONFIRMED extractable.** The body-rewrite for
  `reference_existing_entity_from_journal_entry` is `entities::
  reference_existing_entity_data_payload(current_data, payload, ref_id)` — a pure
  function, no run/proposal/DB inputs (traced during grilling). It extracts into
  `apply_entity_mutation` cleanly; the manual chip-add path (Slice 4) reuses it
  verbatim with `created_by='user'`, `source=None`. No residual coupling.
- **Verify:** entire existing Rust suite green unchanged — `decide.rs` tests, db
  guarded-race tests, `cargo test`. Zero diff in observable behavior.

### Slice 1 — Core: `mutate` module + `entity/mutate` RPC

> **Transport (mandated by ADR-0014, not a style choice):** ADR-0014 — "Requests
> handle reads **and mutations**" (line 3), "There is no second transport" (line 5),
> and "REST + WebSocket hybrid … Rejected" (line 127). A new URI/HTTP route would
> violate the accepted ADR. So `entity/mutate` is a new method-string arm in the
> `dispatch` match (next to `entity/list`), carried over the existing single
> loopback WebSocket. The `entity/*` namespace is already reserved for exactly this
> (ADR-0014 line 25). Nothing changes at the connection layer.

- New `crate::mutate::apply(pool, mutation_kind, payload) -> Result<Outcome,
  MutateError>`: `entities::validate` → shared target validation → one tx →
  `apply_entity_mutation` with `created_by='user'`, `proposal_id=NULL`, source =
  the JE if `source_journal_entry_id` present else `None` → commit → return
  `entity_id` (None for delete).
- Extract the **run-independent** checks from `decide::validate_mutation_target`
  (project_id is a Project, person_id is a Person, target is the right type) into a
  shared helper both `decide` and `mutate` call. The **same-thread journal guard**
  stays in `decide` only — manual journal edits are thread-less by design (see
  "Open points").
- **Sentinel-`null` clear in the partial-merge core** (behavior change — belongs
  here, not in zero-diff Slice 0). Teach `apply_update_todo`'s merge (and the
  `update_project`/`update_person` equivalents) a three-way: a key set to `null`
  in the partial **removes** that key from the merged data; any other value sets
  it; an absent key preserves. Today's merge is set-or-preserve only ("no
  explicit-clear semantics", db/mod.rs) so a user clearing a `due_at`/`project_id`
  is silently ignored. Update `validate_partial_todo_data` to accept `null` as
  clear and drop the empty-string `project_id` special-case in favor of uniform
  `null`. This upgrades the agent path too (it legitimately cannot clear today).
  Ships with merge tests for all three cases (set / clear / preserve) per
  clearable field.
- New protocol types `EntityMutateParams { mutation_kind, payload }` /
  `EntityMutateResult { entity_id? }` in `protocol.rs` (Rust) +
  `packages/protocol/src/index.ts` (TS) with the mirror/contract test.
- Dispatcher arm `"entity/mutate"` + handler (combinator pattern, `handler::handle`);
  map `MutateError` → wire codes (`Invalid → -32602`, `Internal → -32603`).
- **No `entity/changed` notification this feature** (see "View refresh" below) —
  Slice 1 ships only the `entity/mutate` request/response.
- **Verify:** handler tests for each `mutation_kind` (create/update/delete ×
  person/project/todo/journal_entry) asserting the entity lands with
  `created_by='user'` and a `proposal_id=NULL` revision; mirror test for the new
  types.

### Slice 2 — SDK + web data layer (refresh via self-invalidation)

- Add `entityMutate(params)` to `ui-sdk` `WsClient` (request/response only; no new
  stream).
- React Query mutation hook `useEntityMutation` that calls `entityMutate` and
  invalidates the `library-items` query on success — covers 100% of manual CRUD
  (the client that wrote is the client that refreshes).
- **Ride-along fix:** invalidate `library-items` on the **existing**
  `proposal/changed {status:"accepted"}` stream (`proposalNotifications`, already in
  the SDK). This fixes a *pre-existing* bug — today the Library does not refresh
  when the agent's proposal lands; `useLibraryItems` is one static query with no
  invalidation wired (confirmed in code). No new protocol surface.
- **Verify:** `ui-sdk` builds, web typechecks, vitest: mutation success invalidates
  `library-items`; an accepted `proposal/changed` event triggers refetch.

### Slice 3 — Web: GTD create / edit / delete in the rail (Person, Project, Todo)

- `EntityDetail` view↔edit toggle; per-kind edit forms from existing primitives
  (`Input`, `SearchField`, `Button`, `Field`/`Section`). Map form state →
  `{mutation_kind, payload}` (e.g. `create_todo` envelope `{todo, person_refs?}`,
  `update_todo` partial + `set/add/remove` ref ops, `project_id` link).
- "New {Kind}" header action → blank rail form. Inline delete confirm in footer.
- Person/Project/Todo share the form scaffolding; build Todo first (richest:
  status, project link, person refs), then Person, then Project.
- **Verify:** vitest — create Person calls `entityMutate` with a `create_person`
  payload; edit Todo emits `update_todo` with only changed fields + ref ops;
  delete confirm emits `delete_*`; rail returns to view mode on success.

### Slice 4 — Web: Journal Entry full-fidelity editor

- Create (`occurred_at`/`ended_at` + text body) and delete.
- Rich body editor over `[{type:text} | {type:entity_ref, ref_id}]`: edit/reorder
  text, keep/remove existing chips (→ `update_journal_entry`), and **add a new
  chip** linking an existing Entity (→ `reference_existing_entity_from_journal_entry`,
  which mints the `entity_ref` and rewrites the body).
- **One-new-chip-per-call contract (must-hold).** `reference_existing_entity_data_payload`
  rewrites *every* `entity_ref` placeholder node to the *same* freshly-minted
  `ref_id` — safe only when a single placeholder is submitted. So the editor must
  send **one reference mutation per newly added chip**; never batch two new chips
  into one call (both would collapse onto one `ref_id` → data loss). Existing chips
  already carry their own `ref_id` and ride `update_journal_entry` untouched.
- Build chip-add **last** (after create/edit/delete + text-body edit), so the
  richest interaction is the final increment.
- Expanded rail width for this editor.
- **Verify:** vitest — create/edit/delete map to the right `mutation_kind`; each
  added chip routes to its own reference mutation (two new chips ⇒ two calls); chip
  remove routes to `update_journal_entry` with the surviving body; existing chips'
  `ref_id`s preserved.

### Slice 5 — ADR + docs

- ADR-0033 "User-initiated entity CRUD writes directly; Proposals gate the agent"
  amending ADR-0016 (scope it to Worker-initiated mutations; record the shared
  `apply_entity_mutation` seam, the `created_by='user'`/NULL-proposal audit story,
  the same-thread-guard relaxation for manual journal edits, the sentinel-`null`
  clear semantics, and the delete-vs-parked-proposal `NotDecidable` mapping).
- **CONTEXT.md term split (DONE during grilling):** "Canonical Entity" is the
  tier-2 umbrella; "Accepted Entity" is the proposal-born subset. Entity lifecycle,
  Canonical/Accepted Entity, tier-2 contents, Todo Person Reference, and Entity
  Reference glossary entries updated. ADR-0033 must note it reconciles the older
  umbrella use of "Accepted Entity" in ADR-0004 (line 9), ADR-0010 (line 14),
  ADR-0014 (line 25 `entity/*`), and ADR-0016 (line 11) — those now mean Canonical
  Entity. (Edit those ADR lines in this slice, or note the supersession in 0033.)
- Add the `entity/mutate` method to ADR-0014's `entity/*` namespace section.
- **Verify:** ADR is valid; CI gate green; optional `deep-review` pass.

## Open points (resolve during build, not blocking)

- **Manual journal edit/delete bypasses the same-thread guard.** ADR-0030 deferred
  cross-thread journal refinement *for the agent*; a Library edit is thread-less,
  so the guard simply does not apply to the user path. Recorded in ADR-0033.
- **Clearing optional fields (RESOLVED): sentinel `null`.** Manual editing makes
  "clear this field" a first-class action (remove a due date, unlink a Project,
  blank a note) that the agent never needed. The partial-merge core gains a
  three-way (`null` = clear, value = set, absent = preserve), extending the shared
  apply core rather than forking it. Rejected: full-replace for manual updates
  (forks the merge, defeats "one apply core") and "can't clear in V0" (ships a
  visibly broken editor). Detailed under Slice 1.
- **One RPC vs three.** `entity/mutate` (single discriminated method) mirrors the
  Worker's single tool and reuses the envelope — preferred over
  `entity/create|update|delete`.
- **`entity/changed` deferred, not dropped.** ADR-0014 specifies `entity/changed` /
  `entity/subscribe_changes` (lines 25, 36, 45, 55) as a live-only invalidation
  Notification for cross-client refresh, but it is **unbuilt** today and no view
  wires invalidation. This feature defers it: self-invalidation (own mutation +
  the existing `proposal/changed` stream) covers the single-user case ADR-0007
  scopes us to, and ADR-0014 explicitly treats these Notifications as optional
  "refetch this view" hints a client may miss and recover from on reconnect.
  Reintroduce `entity/changed` when a second concurrent Client exists — additive,
  on-protocol, reversible.
- **Concurrency.** User edit + agent proposal on the same Entity: last-writer-wins
  on `entities.data`, independent revisions, no single-writer gate — matches the
  current model and is fine for single-user local-first (ADR-0007).
- **Delete vs. parked proposal (RESOLVED).** Manual delete makes a new race
  reachable: user deletes Entity X, then accepts a parked agent proposal targeting
  X. Today this surfaces as `DecideError::Internal` → `-32603` (opaque; Run stuck
  parked). Fix in Slice 1: `decide` maps "apply target row gone" (the
  `update/delete` affected-0-rows path) to `DecideError::NotDecidable("proposal
  target no longer exists")` → `-32002` — the code the web client already handles
  as "proposal not pending", so the parked Run cancels cleanly. No blocking
  invariant (single-user; the race requires deliberate interleaving). The mirror
  case (user edits while an agent `update_todo` is parked) needs nothing — the
  in-tx merge already reads current state.
- **Manual create provenance (RESOLVED): source row iff there's a real source.**
  A plain Library "New {Kind}" create has no Message and no JE anchor, so it inserts
  **no** `entity_source` row — `created_by='user'` is the origin discriminator. The
  `entity_sources` CHECK (exactly one of message/entity source) is satisfied by
  inserting nothing; no `entities`→source FK is mandated, so this is legal. Rejected:
  a new `relation='user_created'` with both columns null (needs a CHECK-relaxing
  migration for a row pointing nowhere). Consequence: "every entity has a provenance
  row" stops being a global invariant; `EntityDetail`'s "Back to source" footer
  becomes conditional on a source existing (it should be anyway). **Exception:** a
  create from the Journal Entry editor (Slice 4) *does* have an anchor — it writes a
  `created_from` JE source, reusing the agent's provenance shape. Rule: provenance
  follows the anchor when one exists, absent when the user creates from nowhere.
```
