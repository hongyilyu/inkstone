# Workspace capture is one intent graph: batched recognition, deterministic Core resolve, one atomic apply

Journal extraction today is procedural by architecture, not just by prompt. Each `propose_workspace_mutation` carries exactly one `{mutation_kind, payload}` (`tools/propose_workspace_mutation.rs`), and the Run loop tears the Worker down and parks on the **first** proposal frame it sees (`worker/run.rs` — `is_proposal(&name) && !should_auto_approve()` → `park_on_proposal` → `worker.shutdown()` → `break`, per ADR-0025). Worse, extraction is gated on the Journal Entry being **accepted first** (`workflows/default.toml` — "from that accepted Journal Entry … once that create is accepted"): the model cannot even recognize the people/projects/todos in an entry until the entry itself is a committed row. So one journal message fans out into N independent park/resume cycles with N independent user decisions, and the model relies on prompt sequencing to continue the right steps across resumes. That sequencing breaks: the run creates the Todo and the Person, then drops the Project and the Todo→Project link, leaving a partially-applied extraction (GitHub #179). Atomicity exists *within* a Proposal but not *across* the capture.

This ADR makes the whole capture **one logical mutation**: the model recognizes and emits a single **intent graph** (candidate entities + intended links), Core resolves it deterministically (exact-match existing, create missing, link) and applies the accepted subset in **one transaction**. Partial application becomes structurally impossible, and recognition no longer waits on a prior commit.

## Decision

Add one agent-proposable mutation kind, **`apply_intent_graph`**, carrying a graph payload. The model emits **raw candidates + intended links** — never ids it minted, never edits to existing entities. Identity inside the graph is a **handle**: a model-assigned local label (`"@morris"`) that links and body references join on. Core mints real entity ids only at apply.

```ts
type IntentGraph = {
  // Present for journal-anchored capture; ABSENT for direct multi-entity capture
  // ("remember Alice and I owe her an email" — no journal-worthy event).
  journal_entry?: {
    handle: string;                 // e.g. "@je"
    occurred_at: string;            // local YYYY-MM-DDTHH:MM:SS
    ended_at?: string;
    body: IntentBodyNode[];         // entity_ref nodes carry a `target` HANDLE
  };
  entities: IntentEntity[];         // >= 1 (a JE-only capture uses create_journal_entry, not this kind)
  links: IntentLink[];
};

type IntentBodyNode =
  | { type: "text"; text: string }
  | { type: "entity_ref"; target: string };   // target = a handle in `entities`

type IntentEntity = {
  handle: string;                   // graph-local id the links/body reference
  type: "person" | "project" | "todo";
  // type-specific fields, validated by the existing per-type validators:
  //   person  → { name, note?, aliases? }
  //   project → { name, outcome?, note?, ... }
  //   todo    → { title, note?, defer_at?, due_at? }   (project_id comes from a link, not here)
  existing_id?: string;             // OPTIONAL model hint from search_entities; Core re-resolves regardless
};

// Three link kinds — each a genuine recognition choice. There is NO journal_source
// link: provenance is not a model decision (see "No provenance writes").
type IntentLink =
  | { kind: "todo_project"; from: string; to: string }                // Todo handle → Project handle
  | { kind: "todo_person";  from: string; to: string; role: "waiting_on" | "related" }
  | { kind: "journal_ref";  from: string; to: string };               // JE handle → entity handle (body mention)
```

**Core owns resolution and application.** On receipt and again at apply, Core:

1. **Resolves** each entity to a `disposition`:
   - `existing_id` names an accepted entity of the right type → `reuse` (honor the hint).
   - else exact-match (case-insensitive) by name/title + type against accepted entities (the `search_entities` predicate, run in-tx) → exactly one match → `reuse`; zero matches → `create`; **two or more matches → `ambiguous`**.
2. **Topologically orders** so a parent exists before a dependent: Journal Entry → People/Projects → Todos (a Todo's `project_id` needs its Project resolved first).
3. **Applies the accepted subset in one transaction** — every created entity, the Todo's `project_id`, every `TodoPersonRef`, and (when a `journal_entry` node is present) its body woven with **all** surviving `EntityRef`s in a **single** Journal Entry write.

`apply_intent_graph` is **additive and create-and-link only**. The single-entity kinds (`create_todo`, `create_journal_entry`, …) stay; the model uses the graph only when capture yields **≥1 extracted entity or any link**. Pure prose with nothing to extract stays `create_journal_entry`. The graph **never edits the content of an existing entity** — per ADR-0030, extracted entities "own their current structured state" once accepted; a `reuse` node is linked-to and mentioned, never rewritten.

### Two flavors, one kind

- **Journal-anchored** (`journal_entry` present): mints the JE, weaves `journal_ref` body mentions, writes the JE→message guard row. The #179 case.
- **Direct multi-entity** (`journal_entry` absent): no body, no `journal_ref` links permitted, entities + `todo_project`/`todo_person` links only. "Remember Alice and I owe her an email."

Structural validation is conditional: a `journal_ref` link or a body `entity_ref` **requires** a `journal_entry` node; a graph without one must carry neither.

### `disposition` and ambiguity

`proposal/get` ships the **resolved plan** so the Client renders create-vs-reuse without re-resolving:

```ts
type ResolvedNode =
  | { handle: string; type: EntityType; disposition: "create"; label: string }
  | { handle: string; type: EntityType; disposition: "reuse"; entity_id: string; label: string }
  | { handle: string; type: EntityType; disposition: "ambiguous"; candidates: { entity_id: string; label: string }[] };
```

An `ambiguous` node **has no silent fallback** — Core will neither guess one match nor mint a duplicate. Until the disambiguation picker ships (fast-follow, tracked separately), the only valid action on an ambiguous node is **reject** (don't link; the name stays plain text). "Accept all" cannot sweep past an unresolved ambiguity. When the picker ships, the user resolves it via the per-node `entity_id` override, which collapses `ambiguous → reuse`.

## Sequential review, one atomic commit (UX)

The user reviews **one entity card at a time** — the familiar single-entity card — but the whole graph is **one Core Proposal, one park, one atomic apply**. "Sequential" is purely client-side rendering and staging:

- Core parks once on the single `apply_intent_graph` Proposal and ships the resolved plan via `proposal/get`.
- The Client renders the plan as a progress queue and walks the user through accept/reject **per node**, accumulating decisions **locally**. Nothing is written while stepping; quitting mid-review loses only the in-progress selection (zero rows written — consistent).
- On commit, the Client sends **one** `proposal/decide` whose decision is a **vector of per-node decisions**, one idempotency key for the batch:

```ts
type ProposalDecide = {
  proposal_id: string;
  // For apply_intent_graph: a vector keyed by handle. For the 13 single-entity
  // kinds: the unchanged scalar `decision` + optional `edited_payload`.
  decisions: {
    handle: string;
    decision: "accept" | "reject";   // no per-node "edit": edited_fields subsumes it
    entity_id?: string;              // override the resolved id (picker / disambiguation) — accept only
    edited_fields?: object;          // correct a CREATE node's content before it is minted — accept only
  }[];
  decision_idempotency_key?: string;
};
```

Per node: `reject`, `accept`, `accept` with `edited_fields` (correct create-node content — this *is* the old `edit`), or `accept` with `entity_id` (override a reuse/ambiguous match). `edited_fields` and `entity_id` are mutually exclusive per node (you edit what you create; you override what you reuse). **Reject-all** is the existing `decision: "reject"`; **accept-everything-unchanged** is a vector of plain accepts.

**Core owns the cascade.** Given the stored graph + the decision vector, Core joins on handle and reconciles before the tx:

- **Reject a Project, keep its Todo** → the `todo_project` link drops; the Todo lands standalone (ADR-0031 "keep the Todo valid on its own").
- **Reject an entity a JE references** → its `journal_ref` drops and the body `entity_ref` placeholder collapses to text.
- **Reject the `@je` node** → the journal-anchored capture collapses: nothing can be woven and there is no anchor, so journal-sourced nodes apply as direct-capture entities or are dropped per their other links. (A direct-capture graph has no `@je` node and is unaffected.)
- A link whose endpoint did not resolve is **dropped and reported**, never dangling-written. A *required* resolution that fails (an unvalidatable candidate) fails the **whole** transaction → application error, never silently partial.

This needs **no new durable Core state and no multi-park**: nothing commits mid-review, so the commit is the existing decide path applying an accepted subset atomically. Core's "one Proposal = one Decision = one atomic apply" invariant (ADR-0025) holds; the *unit* widens from one entity to one graph. The idempotency key replays the **effective** decision (the persisted accepted subset, including overrides and edits), so a retry yields the same applied result rather than re-resolving.

## No provenance writes

The graph writes **no entity-provenance (`EntitySource`) rows for created entities** — neither `created_from @je` nor `created_from message`. An entity's discoverability is derived from **backlinks**, which is what an entity view actually needs:

- **Mentioned in** → `EntityRef` rows whose `target_entity_id` is this entity → the Journal Entries that name it.
- **Linked Todos** → `todo_person_refs` (for a Person) or Todos with `project_id` = this (for a Project).

The **only** `entity_sources` write the graph makes is the `journal_entry` node's own `created_from` **user-Message** row. That row is not provenance display — it is the sole input to the **cross-thread guard** (`journal_entry_target_is_valid`): entities carry no `thread_id`, so this JE→message link is what stops the agent editing or deleting a Journal Entry from a different Thread (ADR-0030). Because the JE node is always newborn in this Run (see below), that guard row is correct by construction — sourced from this Run's user Message in this Thread, with no new cross-thread logic.

This retires the "Captured from" footer (PR #166) for graph-created entities; the entity view's backlink redesign is separate downstream work (tracked separately), not part of this feature.

## Validation: receipt + decide

Graph-internal structural errors (a link endpoint or body `target` naming an undeclared handle; duplicate handles; a `journal_ref`/body-ref without a `journal_entry` node; `entities` empty; a cycle) are caught at **two** gates:

- **Receipt** (`park_on_proposal`, graph kind only — a new behavior scoped to this kind). A structurally broken graph never parks: Core resolves the awaited tool call with an error result so the model **self-corrects in the same turn** before the user ever sees a card. The graph is the most structurally complex payload the model emits, so same-turn self-correction earns its keep here even though the 13 flat kinds are not receipt-validated.
- **Decide** (`entities::validate` + the resolver's pre-checks, the existing structural gate at `decide.rs`). A graph that is broken at commit time → `Invalid` before the tx opens; nothing written.

> **As-built (descoped).** Only the **Decide** gate shipped in the initial implementation. The decide-time gate is comprehensive — `payload_spec().check` (schema), `extract_graph`'s structural checks (`entities` non-empty, unknown type, duplicate handles, link/body-ref endpoint type-match), and the resolver's in-tx disposition checks (ambiguous, missing project) — so every structurally broken graph is rejected as `Invalid` with **nothing written** (correctness is fully protected), and a broken graph that reaches `proposal/get` degrades to an empty `resolved_plan` so the card disables Apply. What is deferred is only the *receipt-time self-correction UX*: a broken graph surfaces as a card the user dismisses (or an apply that fails) rather than bouncing back to the model in the same turn. The receipt gate is a clean follow-up (add the `extract_graph` pre-check in `park_on_proposal` for the graph kind); it changes no committed behavior, only adds an earlier rejection point.

## The JE node is create-only

The `journal_entry` node always **mints** a new Journal Entry; it carries no `disposition`. Extraction from a *pre-existing* accepted JE (re-scan / backfill of an old entry) is **not** a graph operation — it stays the existing single-entity `reference_existing_entity_from_journal_entry` path, deferred as a future extension. This keeps the cross-thread guard trivial (the JE's origin message is always this Run's) and avoids dragging ADR-0030's cross-thread deferral into the graph. A capture left undecided for hours/weeks is handled by the existing park mechanism (ADR-0025) — the JE node is decided *with* the extractions, never before, so there is no "accept the JE first" step.

## How this supersedes earlier ADRs

Two ADRs explicitly rejected this design *for their time*, on reasons that no longer hold once Core resolves the graph in one tx.

- **[ADR-0025](./0025-proposal-park-and-resume.md) — "One Tool Request = one Proposal = one Decision. No batching, no partial approval."** Still true for every other tool. `apply_intent_graph` widens the *unit* of a Proposal from one entity to one resolved graph; it does **not** reintroduce multi-park. `runs.awaiting_tool_call_id` stays singular — Core parks on the first proposal frame, resumes one decision. The per-node vector is one decision over one graph, applied in the one atomic tx ADR-0025 already blesses for "more than one tier-2 row."
- **[ADR-0030](./0030-journal-entry-anchored-capture.md) — rejected "Batch Journal Entry and extracted Entities into one Proposal," and required the JE accepted before extraction.** Both reversed. Batching is now *more* legible (one coherent plan; the Project can no longer silently vanish) and parks once; and recognition no longer waits on a prior commit (the JE is a node decided with the rest). The anchor still holds: when present, the JE is minted first in-tx, and ADR-0030's "extracted entities own their current structured state" (line 52) is the basis for create-and-link-only. ADR-0030's own provenance-display intent is narrowed: the graph writes no extracted-entity `EntitySource`; entity views use backlinks.
- **[ADR-0031](./0031-gtd-todo-person-project-model.md) — "create Todo first so it survives a rejected Project enrichment."** Reversed for the batch path only. With an all-or-nothing graph and a per-node accepted subset, "survive a rejected Project" is handled by the cascade (drop the link, Todo lands standalone), not by creation ordering. Core resolves Projects/People *before* the Todo so the link writes in the same tx. The direct single-entity enrichment flow is unchanged.

PRODUCT.md's "approval is sacred — show what will change" is the affirmative case: a single reviewable plan where every recognized piece is visible beats today's flow where the user approves fragments and a recognized Project never lands.

## Mechanics this pins

- **No tier-2 schema change.** The `proposals` row stores an opaque `payload` against one `mutation_kind` (`migrations/0001_initial.sql`); the graph rides as one payload. `entities`, `entity_refs`, `todo_person_refs`, and `todo.project_id`-in-JSON already exist; their apply primitives are reused.
- **One new closed `mutation_kind`.** `apply_intent_graph` joins `MutationKind` and `ProposableMutation::ALL` (→ 14), ships a graph `payload_spec()` whose `json_schema()` is **fully inlined** — no `$ref` (Anthropic rejects refs), nullable optionals as `["…","null"]` with explicit defaults (advertised-schema-rejects-sentinel-null trap). It has **no single `target_key`** — audit every `target_key.expect(...)` site (`decide.rs::preserve_update_target_entity_id`, `runs/proposal.rs`) so the kind takes a safe branch, not a panic. It does **not** use the `edit` verb (`edited_fields` per node subsumes it).
- **Decide grows a vector path for this kind only.** `ProposalDecideParams` gains `decisions: Vec<NodeDecision>` for `apply_intent_graph`; the 13 single-entity kinds keep the scalar `decision`/`edited_payload`. The decide precedence ladder (keyed replay → recovery → fresh apply) is unchanged; the vector is the fresh-apply input.
- **`DecideOutcome::Accepted { entity_id }` is singular** but a graph creates many entities — report the JE/anchor id (or the first created id for a JE-less graph); the Client re-reads created entities via `entity/changed`. Pin in implementation.
- **Resolution runs in-tx on the serialized pool.** The exact-match predicate mirrors `search_entities` but uses the executor-generic query form against the open transaction (like `recheck_todo_project_link` in `db/apply.rs`), so it sees this tx's freshly-minted entities. `max_connections(1)` makes the read race-free.
- **Multi-ref Journal Entry weave is one write.** Today the reference path mints one `entity_ref` and rewrites one placeholder (`db/apply.rs`). The graph applier mints N `entity_refs` and weaves N `@handle` body placeholders into one Journal Entry revision — satisfying "the Journal Entry is updated once."
- **The apply transaction stays the deep module.** The resolver loops `apply_entity_mutation` (already runs in the caller's tx, commits nothing itself) inside the one tx opened by `apply_proposal`; any error drops the tx.
- **Schema-parity gate forces an atomic slice.** Rust kind + `@inkstone/protocol` TS type + `tests/contract/fixtures/apply_intent_graph.json` move together; web stops sending the kind before Core would reject it. Auto-approve stays off (ADR-0016 empty table) — every graph is manual.

## Consequences

- A journal message yielding Person + Project + Todo + links is one Proposal, one park, one decision, one atomic apply — never a partial extraction, and the model recognizes everything in one pass without waiting on a JE commit.
- The model's job narrows to recognition (emit candidates + links). Resolution authority leaves the `search_entities` *tool* and becomes Core-internal for the graph; `search_entities` stays a read tool for `existing_id` hints.
- The Web Client gains a graph `ProposalView` rendering the resolved plan as a sequential queue within the existing single-card frame, plus a local staging buffer; no store/plumbing change beyond a richer body.
- `default.toml`'s extraction section is rewritten: recognize one intent graph, stop per-entity sequencing and the JE-accepted-first gate. Single-entity direct-capture and pure-prose journaling stay on their existing kinds.
- Entity views move to backlinks (mentioned-in + linked-todos); the "Captured from" footer is retired for graph-created entities (separate downstream work).

## Considered and rejected

- **Client prunes the graph and sends a replacement payload.** Rejected: the reject-cascade is correctness logic (the exact #179 failure mode); it belongs in Core, tested against the resolver, not duplicated in TS. The Client sends per-node decisions; Core cascades.
- **A distinct `accept_partial` / `commit` verb.** Rejected: a partial accept is still an `accept` over a vector; no new verb. Reject-all is the existing `reject`.
- **Make `apply_intent_graph` subsume the single-entity kinds (graph-of-one).** Rejected: forces every trivial capture and the whole single-entity UI through the graph path — large blast radius, no gain. The graph is additive; the model picks it only for ≥1 extracted entity.
- **Let the model emit resolved ids it creates.** Rejected: Core could not then guarantee "failed resolution surfaces as an error, not silently dropped." Core-owned resolve makes whole-graph failure enforceable.
- **Core does fuzzy matching.** Rejected: fuzzy disambiguation is recognition (ADR-0030 places it in the model); fuzzy match in a transaction is a correctness hazard. Core does exact resolve; ambiguity (>1 match) is surfaced, not guessed.
- **A model-emitted `journal_source` link / per-entity `EntitySource` rows.** Rejected: provenance is not a recognition decision, and entity views need backlinks, not origin. The graph writes no entity provenance; only the JE→message guard row.
- **Durable per-node staging / N decide calls.** Rejected: nothing is committed mid-review, so restart-surviving per-node state buys nothing and would re-open multi-park. Client-side staging + one vectored decide is simpler and meets every criterion.

## Related

- [ADR-0016](./0016-proposal-application-policy.md) — one write path, atomic application; the graph applies through it.
- [ADR-0017](./0017-tier-2-schema-slice-1.md) — `mutation_kind` is a closed CHECK-bearing string; the new kind extends it.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — proposal tools are Core-registered; resolution is Rust-in-Core.
- [ADR-0025](./0025-proposal-park-and-resume.md) — superseded in part: the Proposal unit widens to a graph; park/resume unchanged.
- [ADR-0030](./0030-journal-entry-anchored-capture.md) — superseded in part: batching un-rejected, JE-accepted-first dropped; the anchor and "entities own their state" hold; provenance display narrowed to backlinks.
- [ADR-0031](./0031-gtd-todo-person-project-model.md) — superseded in part: create-Todo-first ordering reversed for the batch path; the cascade replaces it.
- [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md) — shared `apply_entity_mutation` core; the resolver loops it.
- [#179](https://github.com/hongyilyu/inkstone/issues/179) — the partial-extraction bug this resolves.
