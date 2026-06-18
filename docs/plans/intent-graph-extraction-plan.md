# Intent-Graph Capture Plan

Implements [ADR-0042](../adr/0042-intent-graph-journal-extraction.md), resolving [#179](https://github.com/hongyilyu/inkstone/issues/179). Workspace capture becomes one recognized intent graph, resolved deterministically by Core and applied in one transaction, reviewed one card at a time but committed atomically.

## Goal

A journal message that names a Person, a Project, and an action yields **one** Proposal carrying an intent graph. Core resolves existing-vs-create (exact match), links Todo→Project and Journal Entry→entities, and applies the accepted subset in a single transaction. The user reviews node-by-node in the UI; nothing partial ever lands; recognition no longer waits on a prior JE commit.

## Target behavior (the #179 example)

Input: *"this morning had a talk with Morris about Lead Ads project, which the scope is very much enlarged that i need to figure out the Rodeo side of work"*

- Model emits one `apply_intent_graph`: JE `@je`; entities `@morris` (person), `@leadads` (project), `@rodeo` (todo); links `todo_project @rodeo→@leadads`, `journal_ref @je→@morris`, `journal_ref @je→@leadads`.
- **Missing-project case:** Core mints Lead Ads, then the Todo with `project_id = leadads.id`, all in one tx.
- **Existing-project case:** Core exact-matches Lead Ads, reuses its id, no duplicate; the JE body gets an `EntityRef` to it.
- The JE body is woven with refs to Morris + Lead Ads in **one** write.
- Reject anything → that node and its dependent links drop; the rest still applies. Reject `@je` → the journal-anchored capture collapses.

## Acceptance criteria (from #179)

1. The example proposes/applies Project `Lead Ads`, Person `Morris`, Todo `Figure out the Rodeo side…`, Todo linked to the Project.
2. Existing `Lead Ads` → Todo links to the existing Project (no dup).
3. Missing `Lead Ads` → Project created before/with Todo linking.
4. JE updated **once** with references for recognized entities.
5. A failed required relationship resolution is a visible graph/application error, never silently dropped.
6. Tests cover the missing-project case and the existing-project case.

## Locked design (from grilling — see ADR-0042)

- **One graph proposal**, one park, one atomic commit. `proposal/decide` carries a **vector** of per-node decisions for this kind; one idempotency key.
- **Handle** is identity throughout (model-assigned `@morris`). Links/body-refs join on handle. Core mints real ids at apply.
- **Core owns resolution** (exact-match): `disposition: create | reuse | ambiguous`. `>1 match → ambiguous`, **no create-fallback** — interim action is reject; picker is fast-follow (#181).
- **Decision node = `{handle, decision: accept|reject, entity_id?, edited_fields?}`** — `entity_id`/`edited_fields` built now, picker UI deferred. No per-node `edit` verb; `edited_fields` subsumes it. `entity_id` (reuse override) and `edited_fields` (create-node content) are mutually exclusive per node.
- **Create-and-link only.** Graph never edits existing entity content (ADR-0030: entities own their state).
- **No entity provenance writes.** Only the JE→message **guard** row is written (cross-thread guard input, not display). Entity views use backlinks (separate work, #182).
- **Two flavors, one kind.** Journal-anchored (`journal_entry` present) and direct multi-entity (`journal_entry` absent). `journal_ref`/body-refs require a JE node.
- **JE node create-only.** No reuse-JE; later extraction from an existing JE stays the existing reference path (deferred, #183).
- **Coexist.** Pure prose → `create_journal_entry`; ≥1 extracted entity → graph.
- **Validation A+B.** Receipt-time structural self-correction (graph kind only) + decide-time structural gate.
- Atomicity via the existing single-tx `apply_proposal`; the resolver loops `apply_entity_mutation` inside it.

## Slices

Each slice ends green on `pnpm format && pnpm lint && pnpm check && pnpm -r test && cargo test --manifest-path crates/core/Cargo.toml`.

### Slice 1 — Contract: the `apply_intent_graph` kind (no behavior)

**Goal:** the kind exists end-to-end as a schema, resolves nothing yet.

- `mutation.rs`: add `MutationKind::ApplyIntentGraph` + `ProposableMutation::ApplyIntentGraph` (→ 14), `from_wire`/`as_wire`/`describe`, **no single `target_key`**. Audit every `target_key.expect(...)` site (`decide.rs::preserve_update_target_entity_id`, `runs/proposal.rs::review_context_for_proposal`) so the kind takes a safe branch, not a panic. `supports_edit()` is false (graph uses the decision vector, not the `edit` verb).
- `field_spec.rs` / `payload_spec()`: the graph spec — optional `journal_entry`, `entities[]` (min 1), `links[]` (the three kinds) — emitting **inlined** `json_schema()` (no `$ref`; nullable optionals `["…","null"]` with defaults).
- `tools/propose_workspace_mutation.rs`: the `oneOf` gains the kind; regenerate fixtures via the `--bin core` path.
- `packages/protocol`: the TS `ApplyIntentGraph` payload type + `ProposalKind` union member; the decision-vector wire type on `ProposalDecide`.
- `tests/contract/fixtures/apply_intent_graph.json`: committed fixture; parity gate green.

**Verify:** parity gate passes; `descriptor()` advertises the kind with no `$ref` and no bare-null sentinel; a hand-built fixture is *accepted* by the advertised schema (assert acceptance, not just round-trip). Accepting one fails loudly as a temporary `Invalid` ("not yet implemented"), asserted by a test.

### Slice 2 — Core resolver + atomic apply (largest)

**Goal:** accepting an `apply_intent_graph` resolves and applies the accepted subset in one tx.

- New resolver module (e.g. `db/intent_graph.rs`): parse graph; structural validation (handles unique, link/body endpoints declared, `journal_ref`/body-ref ⇒ JE node, `entities` non-empty, no cycle); in-tx exact-match resolve per entity → `create|reuse|ambiguous` (mirror `search_entities`, executor-generic like `recheck_todo_project_link`); honor `existing_id`; topo-order JE → people/projects → todos; loop `apply_entity_mutation` for created entities in the caller's tx; map handles → ids; apply `todo_project` (`project_id`) + `todo_person` (`TodoPersonRef`) links; write the JE→message guard row for the JE node. **No entity-provenance rows.**
- Decision-vector apply in `decide.rs`: join the stored graph with the per-node decisions; cascade rejected nodes (drop dependent links/body-refs); honor `entity_id` override (validate accepted + type-matched) and `edited_fields` (merge over create-node payload, validate with per-type validator); apply accepted subset; report dropped links; a required-resolution failure or an unresolved `ambiguous` accept → roll back whole tx, `Invalid`. `DecideOutcome` reports the JE/anchor id (or first created id).
- Wire into `apply_proposal` (`db/mod.rs`); remove the slice-1 "not implemented".

**Verify (the acceptance tests):**
- Missing-project: one accept-vector → Project + Person + Todo exist, Todo.project_id = Project.id. Entity count exact, no provenance rows beyond the JE guard row.
- Existing-project: pre-seed Lead Ads → accept → no second Project, Todo links to existing id.
- Failed/ambiguous resolution: required candidate invalid, or accept of an ambiguous node → nothing written, error surfaced (`entity_count == 0`).
- Cascade: reject Project, accept its Todo → Todo lands standalone, no `project_id`.
- Reject-all → zero rows.

### Slice 3 — Multi-ref Journal Entry weave in one write

**Goal:** the JE body is woven with **all** surviving refs in a single revision.

- Extend the JE write so the resolver mints N `entity_refs` for surviving `journal_ref` links and rewrites N `@handle` body placeholders in one revision (vs the current one-target-per-call path, `db/apply.rs`). A rejected referenced entity collapses its placeholder to text. Called once from the resolver.

**Verify:** a graph with Person + Project refs bumps the JE `entity_revisions` seq exactly **once**; both `entity_refs` rows exist; placeholders resolve; a rejected ref leaves clean text. Mutation-test the "once".

*(Slices 2 and 3 may merge if one author owns both; kept separate to isolate the under-scope-prone multi-ref weave.)*

### Slice 4 — Prompt / workflow rewrite

**Goal:** the model emits one intent graph; per-entity sequencing and the JE-accepted-first gate are gone.

- `workflows/default.toml`: rewrite extraction — after a journal-worthy message, recognize one intent graph (entities + the three link kinds, with `existing_id` hints from `search_entities`) and propose one `apply_intent_graph` when **≥1 entity** is extracted. Keep `create_journal_entry` for pure prose and the single-entity direct-capture rules for trivial one-entity cases. Drop "propose ONE mutation at a time; never batch", the two-step create-then-reference flow, and "from that accepted Journal Entry".

**Verify:** an e2e Worker run on the #179 example produces exactly one `apply_intent_graph` proposal whose graph holds the Project as a **distinct node** from the Todo (guards the original "action phrase became the Project" confusion); a pure-prose entry still produces `create_journal_entry`.

### Slice 5 — UI: sequential review, atomic commit

**Goal:** one card shows the resolved plan; the user steps through; commit sends one vectored decide.

- `packages/protocol` + `proposal/get`: ship the **resolved plan** (`ResolvedNode[]` with `disposition`, candidates for ambiguous, links) so the Client renders without re-resolving.
- `apps/web` `ProposalCard.tsx`: new graph `ProposalView` whose `renderBody` renders the queue — progress rail + one node card at a time + a final review summary with create/reuse/ambiguous badges and dropped-link notices.
- Local staging buffer (component state, not the store): accumulate per-node accept/reject; build the decision vector; commit → one `proposal/decide` with `decisions[]`. Reject-all → `reject`. An ambiguous node blocks "accept all" (reject-only until picker).
- Reconcile-before-commit notices (reject-Project-keep-Todo → "Todo will be created without its project link").

**Verify (browser):** the #179 example shows one card with 4 nodes; stepping all-accept then commit lands all four linked; rejecting Lead Ads then commit lands the Todo standalone with a shown downgrade; reject-all lands nothing; an ambiguous node cannot be accept-all'd. Screenshot the plan card.

## Risks / sharp edges

- **`target_key`-assuming sites panic on a graph kind** — audit `decide.rs` / `runs/proposal.rs` / `mutation::target_entity_id` (slice 1).
- **`DecideOutcome::Accepted { entity_id }` is singular** — report the anchor/first id; Client re-reads via `entity/changed` (slice 2).
- **Advertised-schema null/`$ref` traps** — hand-build the fixture, assert the *advertised* schema accepts it.
- **Conditional structural validation** — `journal_ref`/body-ref must require a JE node; a no-JE graph must reject both. Test both flavors.
- **Multi-ref weave under-scoped** — slice 3 is genuinely new Core capability; isolate and mutation-test the "once".
- **Idempotency replays the effective decision** — persist the accepted subset + overrides/edits so a retry yields the same applied result, not a re-resolve.
- **Parity gate ordering** — Rust kind + TS type + fixture atomic; web stops sending before Core rejects.
- **Auto-approve stays off** (ADR-0016 empty table).

## Out of scope (tracked as separate issues)

- **Disambiguation picker** (the `ambiguous` → `entity_id` override UI) — fast-follow, #181.
- **Entity backlink view** (mentioned-in + linked-todos; retire "Captured from" footer) — #182.
- **Re-scan / backfill** extraction from a pre-existing accepted JE — #183.
- Auto-approve policy for graphs; cross-thread JE refinement; fuzzy matching in Core; subsuming single-entity kinds.
