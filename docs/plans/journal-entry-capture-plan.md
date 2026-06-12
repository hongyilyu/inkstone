# Journal Entry Capture Plan

## Goal

Model chat-driven interstitial journaling so a rough user Message can become a canonical Journal Entry, and accepted Journal Entries can source/reference extracted Person, Project, and Todo Entities.

## Mental Model

```text
Message
  raw user chat input and later refinement evidence

JournalEntry
  accepted event/evidence record refined from one or more user Messages

Person / Project / Todo
  structured Entities extracted from JournalEntry when appropriate

EntitySource
  provenance: why this Entity exists

EntityRef
  inline JournalEntry reference to an accepted Entity

DailyNote
  derived view: JournalEntries grouped by occurred_at local day
```

Relationships:

```text
Message -> JournalEntry[] is allowed
JournalEntry -> user Message[] is allowed
JournalEntry sources may cross Thread boundaries
```

## Core Objects

```ts
type EntityType = "journal_entry" | "person" | "project" | "todo";

type JournalBodyNode =
  | { type: "text"; text: string }
  | { type: "entity_ref"; ref_id: string };

type JournalEntryData = {
  occurred_at: string;
  ended_at?: string;
  body: JournalBodyNode[];
};
```

```ts
type EntitySource = {
  entity_id: string;
  source_entity_id?: string;
  source_message_id?: string;
  relation: "created_from" | "updated_from" | "evidenced_by";
};
```

```ts
type EntityRef = {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  label_snapshot?: string;
};
```

## Invariants

- Every `entity_ref` node in a Journal Entry body points to an `EntityRef` by `ref_id`.
- `EntityRef` is the authoritative inline-reference object: it owns target Entity and fallback label.
- In v1, every `EntityRef.source_entity_id` is a Journal Entry Entity.
- Every `EntityRef.target_entity_id` points to an Accepted Entity.
- In v1, `EntityRef` has no role field. For Journal Entry refs, meaning is derived from the target Entity Type: Person means person involved, Project means project/context, Todo means action item.
- Creating or removing a Journal Entry `entity_ref` and creating or removing the corresponding `EntityRef` is one atomic mutation.
- Removing an `entity_ref` from a Journal Entry body removes the corresponding `EntityRef`; adding an `entity_ref` creates the corresponding `EntityRef`.
- Journal Entries have no hidden non-inline Entity Refs in v1. If a reference is not represented in the body, it is not referenced from the Journal Entry.
- Referencing an existing Entity from a Journal Entry writes an `EntityRef` only. It does not write an `EntitySource` for the target Entity, because a mention is not provenance for why that target Entity exists.
- For a repeated entity in the same Journal Entry, only the first meaningful occurrence becomes an `entity_ref`; later occurrences stay text.
- In v1, keep at most one `EntityRef` per `(JournalEntry, target Entity)`.
- `EntityRef.target_entity_id` is authoritative. `EntityRef.label_snapshot` is fallback text for readable rendering when the target Entity cannot be loaded; normal UI should render the current Entity title from `target_entity_id`.
- Each `EntitySource` row points to exactly one source target: either `source_entity_id` or `source_message_id`, never both and never neither.
- Entity Sources record provenance only. Entity Refs record inline Journal Entry references only.
- Journal Entries source from user Messages. Person, Project, and Todo Entities extracted by the journal flow source from the accepted Journal Entry.
- V1's product/data-object model uses only current Journal Entry, Entity Source, and Entity Ref state. It does not add a user-facing revision-history concept; Core may still write internal entity revision snapshots through the existing storage path.

## Capture Flow

Example input:

```text
10:30 talked to Alice about Project Y, where I have to talk to Bob to align on Z
```

Flow:

1. User posts a Message in chat.
2. Dispatcher/Router classifies the Run as journal capture or ordinary chat.
3. Worker proposes one or more Journal Entries sourced from the user Message.
4. Core auto-approves or surfaces each Journal Entry Proposal.
5. Accepted Journal Entry stores normalized time in `occurred_at` / `ended_at`; the body contains only event content, not a time prefix.
6. Missing/unaccepted names remain text. `entity_ref` nodes only point to Entity Refs whose targets are accepted Entities.
7. Worker extracts candidate People, Projects, and Todos from the accepted Journal Entry.
8. Worker proposes one mutation at a time.
9. Core applies accepted mutations atomically and records Entity Sources / Entity Refs.
10. Rejected proposals create no Entity and no Entity Ref.
11. Daily Note renders accepted Journal Entries for the `occurred_at` local day.

Initial accepted Journal Entry can be:

```ts
[
  {
    type: "text",
    text: "Talked to Alice about Project Y, where I have to talk to Bob to align on Z",
  },
]
```

After accepted existing-entity refs and accepted created-entity proposals:

```ts
[
  { type: "text", text: "Talked to " },
  { type: "entity_ref", ref_id: "ref_entry1_alice" },
  { type: "text", text: " about " },
  { type: "entity_ref", ref_id: "ref_entry1_project_y" },
  { type: "text", text: ", where I have to talk to " },
  { type: "entity_ref", ref_id: "ref_entry1_bob" },
  { type: "text", text: " to align on Z" },
]
```

Those `ref_id` values resolve through `EntityRef` rows:

```ts
[
  {
    id: "ref_entry1_alice",
    source_entity_id: "journal_entry_1",
    target_entity_id: "person_alice",
    label_snapshot: "Alice",
  },
  {
    id: "ref_entry1_project_y",
    source_entity_id: "journal_entry_1",
    target_entity_id: "project_y",
    label_snapshot: "Project Y",
  },
]
```

## Proposal Sequence

Worker submits Proposals one at a time. Core either parks for a user Decision or auto-approves through the same Proposal path. A single accepted Proposal may apply multiple tier-2 row changes atomically when those writes are one logical Workspace mutation.

For journal extraction, creating one extracted Entity from a Journal Entry and inline-referencing it from that same Journal Entry is one logical mutation. Creating two extracted Entities is two logical mutations.

For the example input:

1. `create journal_entry`
   - source: user Message
   - body: refined entry content
   - `occurred_at`: concrete timestamp
   - `ended_at`: optional concrete timestamp

2. `reference existing person`
   - if Alice exists, reference Alice from the Journal Entry body
   - on accept, update the Journal Entry body and create an `EntityRef`
   - do not create an `EntitySource` for Alice; this entry mentions Alice, but Alice does not exist because of this entry
   - Core may auto-approve this based on confidence/policy
   - still goes through the Proposal/tool-call path, even if auto-approved

3. `create project`
   - if Project Y does not exist, propose Project Y
   - source: JournalEntry
   - on accept, create Project, create an `EntitySource` for Project Y with the Journal Entry as source, update the Journal Entry body, and create an `EntityRef`

4. `reference existing person` or `create person`
   - Bob follows the same existing-or-create path

5. `create todo`
   - only if the text contains an actual action
   - source: JournalEntry
   - JournalEntry can reference the Todo as an action item
   - Todo-to-Person and Todo-to-Project semantics are defined by [ADR-0031](../adr/0031-gtd-todo-person-project-model.md) and [the GTD plan](./gtd-todo-person-project-plan.md)

## Rules

- Journal Entry is created before extracted Person/Project/Todo Entities.
- One user Message may produce multiple Journal Entries.
- One Journal Entry may be sourced/refined by multiple user Messages.
- Journal Entry sources may come from multiple Threads.
- Only user Messages are Entity Source evidence. Assistant Messages are Thread context, not provenance.
- Extracted Entities source from the Journal Entry, not directly from the raw Message.
- Entity Refs are inline references; they do not edit the target Entity.
- Existing-entity reference Proposals create `EntityRef` rows, not `EntitySource` rows.
- A rejected Entity Proposal means no created Entity and no Entity Ref.
- Unresolved mentions are not canonical tier-2 state.
- `entity_ref` body nodes only point to Entity Refs whose target is an accepted Entity.
- Referencing an existing Entity from a Journal Entry is a Worker-originated mutation, so it goes through Proposal policy. Core may auto-approve it.
- Latest accepted Journal Entry update wins. Conflict surfacing is Workflow behavior, not Journal Entry state.
- Daily Note is generated by querying Journal Entries by `occurred_at` local day.
- Manual `@mention` editing is separate CRUD/editor scope. The chat-capture flow only needs Core/Worker to produce structured body nodes and Entity Refs.

## Time Rules

Journal Entry time is explicit metadata, not text embedded in `body`.

`occurred_at` / `ended_at` store normalized concrete times. Validation requires `occurred_at`. `ended_at` is optional; when present, it must be greater than or equal to `occurred_at`. Missing `ended_at` and `ended_at === occurred_at` both represent point events.

```text
date = explicit user date > relative user date > source Message capture date
time = explicit user time > vague default > source Message capture time
```

Vague defaults:

```text
morning   -> 09:00
lunch     -> 12:00
afternoon -> 15:00
evening   -> 18:00
tonight   -> 20:00
```

The Proposal UI should show the normalized time clearly and allow correction.

## Implementation Slices

1. **Domain shape**
   - Add Journal Entry as an Entity Type.
   - Add Entity Source persistence.
   - Add validation for Journal Entry body nodes.

2. **Journal capture Proposal**
   - Replace `propose_entity` with `propose_workspace_mutation`.
   - `propose_workspace_mutation` accepts a closed enum of Core-known domain mutations, not generic table-level CRUD.
   - The existing default Workflow proposes Journal Entries when prompted or when the Message is clearly journal-like.
   - Reminder/task/todo-shaped Messages are not Journal Entries in the first slice; until Todo extraction exists, the assistant replies conversationally and does not create a Proposal for them.
   - Worker proposes one or more Journal Entries from the user Message.
   - Core applies accepted Journal Entry and Entity Source to the user Message.

3. **Extraction chain**
   - Add Entity Ref persistence.
   - Worker reads accepted Journal Entry.
   - Worker searches existing Entities.
   - Existing matches become reference proposals.
   - Missing durable concepts become create-entity proposals.
   - Action obligations become Todo proposals.

4. **Daily Note view**
   - Query Journal Entries by `occurred_at` local day.
   - Render structured body nodes.
   - Include referenced People, Projects, and Todos.

5. **Future rewind**
   - Daily/weekly rewind creates a separate review/synthesis Entity if the user saves it.
   - Add tier-3 projection/cache only if day/week rendering becomes slow.

## First Implementation Scope

The first implementation slice proves the Journal Entry anchor before extraction:

1. Add `journal_entry` Entity validation.
2. Add `entity_sources` persistence.
3. Replace `propose_entity` with `propose_workspace_mutation`.
4. Accepting a Journal Entry Proposal creates the Journal Entry Entity and one `EntitySource` pointing to the source user Message in the same transaction.
5. Rejecting a Journal Entry Proposal creates neither the Entity nor the `EntitySource`.

Out of scope for the first slice: Entity Refs, Person/Project/Todo extraction, Daily Note UI, Journal Entry refinement/update, and auto-approve policy details.

Also out of scope for the first slice: a real Router/Dispatcher classifier. ADR-0011's Dispatcher seam remains, but the first implementation keeps the single default Workflow and proves the write path before adding Workflow selection logic.

Because Entity Refs are out of scope for the first slice, first-slice `create_journal_entry` validation accepts only text body nodes:

```ts
type FirstSliceJournalBodyNode = { type: "text"; text: string };
```

The full `JournalBodyNode` union becomes valid only once Entity Ref persistence exists; before that, accepting an `entity_ref` node would violate the invariant that every `entity_ref` node points to an `EntityRef`.

First-slice body validation:

- Reject an empty `body`.
- Reject any non-text body node.
- Reject text nodes whose `text` is empty or whitespace-only.
- Reject payload fields outside `occurred_at`, `ended_at`, and `body`.
- Allow multiple text nodes so the long-term node-array shape stays stable.
- Core may merge adjacent text nodes before storing; that normalization is not user-visible.

The first slice supports one Journal Entry per `create_journal_entry` Proposal. A single user Message may still produce multiple Journal Entries over the Run, but only as multiple sequential Proposals after each Decision/resume cycle. Do not add a `create_many_journal_entries` mutation in the first slice.

First-slice `proposal/decide { decision: "edit" }` is supported for `create_journal_entry`, but the edit replaces only the Proposal `payload`. Core still derives `source_message_id` and keeps the original `mutation_kind`. The edited payload must pass the same `create_journal_entry` validator before Core applies it.

Journal Entries use the generic Entity lifecycle decided by ADR-0030 / CONTEXT.md: accepting `create_journal_entry` writes `entities.type = "journal_entry"` and a seq-1 `entity_revisions` row.

`propose_workspace_mutation` shape:

```ts
type WorkspaceMutationProposal = {
  mutation_kind: "create_journal_entry";
  payload: {
    occurred_at: string;
    ended_at?: string;
    body: FirstSliceJournalBodyNode[];
  };
  rationale?: string;
};
```

Each `mutation_kind` has a Core-owned payload validator and apply path. The tool does not expose table names, SQL operations, or arbitrary CRUD.

The durable Proposal row stores `mutation_kind`, not an Entity Type `kind`. First-slice Proposals do not need `change_kind`; the closed `mutation_kind` already names the operation Core will apply.

For `create_journal_entry`, the Worker does not provide `source_message_id`. Core derives provenance from the current Run's `user_message_id` and writes the `EntitySource` row in the same transaction as the Journal Entry Entity.

The first-slice `EntitySource` relation for `Message -> JournalEntry` is `created_from`. `updated_from` is reserved for later Journal Entry refinement, and `evidenced_by` is reserved for supplemental evidence that did not create or update the Entity.

## Open Design Checks

- Define exact auto-approve policy for existing-entity refs.
- Decide whether Journal Entry creation is manual approval first, then eligible for auto-approval after trust is established.

## Implementation Contract

- Do not create Daily Note entities in v1; generate the view from Journal Entries.
- Do not store unresolved mentions in tier 2.
- Do not model Todo-to-Person or Todo-to-Project relationships in the Journal Entry anchor slice; implement those through the GTD Todo/Person/Project plan.
- Do not add a generic relationship graph in this slice; `EntityRef` is only for inline Journal Entry body references.
- Do not bypass Proposal policy for Worker-originated Journal Entry creation, Entity creation, or existing-entity reference mutations; Core may auto-approve according to policy.
- Keep user Message evidence in `EntitySource`; assistant Messages are only Thread context.
