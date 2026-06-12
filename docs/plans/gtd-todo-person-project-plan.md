# GTD Todo, Person, and Project Plan

## Goal

Implement the GTD entity model from ADR-0031 in two phases:

- **V0**: persistence foundation that stores and validates the model.
- **V1**: product/workflow behavior built on top of V0.

The full model:

- Todo is the generic actionable Entity.
- Project is a GTD outcome with manual status and review metadata.
- Person is a small descriptive Entity.
- Todo Person Reference is the task-specific Person association.
- Inbox is a derived view over raw active Todos.
- Direct non-journal capture can create Person, Project, or Todo from a Message.
- Journal/event capture still creates JournalEntry first, then extracted Entities.

## Version Boundary

V0 is intentionally boring. It creates the durable substrate:

- Entity payload validators for Person, Project, and Todo.
- `todo_person_refs` persistence.
- transactional create/update/delete apply paths.
- EntitySource writes for direct Message capture and JournalEntry extraction.
- deletion cleanup for Project and Person references.
- low-level read helpers needed by later views and Workflows.

V0 does not need a polished task UI, Worker extraction chain, Inbox view, Review view, or Person/Project detail projections. Those are V1.

V1 depends on V0 and adds behavior:

- direct chat capture and enrichment flows.
- JournalEntry-derived Todo enrichment.
- derived Inbox, Waiting/Follow-up, Person, Project, and Review views.
- UI editing for task context and review.
- Worker proposal sequencing for missing Person/Project links.

## Mental Model

```text
Message
  raw user chat input

JournalEntry
  accepted event/evidence record for journal-worthy input

Todo
  user-owned actionable commitment

Project
  user's desired outcome

Person
  real person remembered by Inkstone

TodoPersonRef
  task/person association for waiting and related task views

EntitySource
  provenance: why an Entity exists

EntityRef
  inline JournalEntry body reference only

Inbox
  derived view over raw active Todos with no organizing metadata
```

Core relationship rules:

```text
Message -> Todo is allowed
Message -> Project is allowed
Message -> Person is allowed

Message -> JournalEntry -> Todo is allowed
Message -> JournalEntry -> Project is allowed
Message -> JournalEntry -> Person is allowed

Todo -> Project is one optional owning project_id
Todo -> Person is one or more TodoPersonRef rows
Project -> Person is derived through Todo
Person -> Project is derived through Todo
```

## Core Data Shapes

```ts
type EntityType =
  | "journal_entry"
  | "person"
  | "project"
  | "todo";
```

```ts
type TodoStatus = "active" | "completed" | "dropped";

type TodoData = {
  title: string;
  note?: string;
  status: TodoStatus;
  project_id?: string;
  defer_at?: string;
  due_at?: string;
  completed_at?: string;
  dropped_at?: string;
};
```

```ts
type ProjectStatus =
  | "active"
  | "on_hold"
  | "completed"
  | "dropped";

type ReviewInterval = {
  interval: number;
  unit: "day" | "week" | "month" | "year";
};

type ProjectData = {
  name: string;
  outcome?: string;
  note?: string;
  status: ProjectStatus;
  defer_at?: string;
  due_at?: string;
  completed_at?: string;
  dropped_at?: string;
  review_every?: ReviewInterval;
  next_review_at?: string;
  last_reviewed_at?: string;
};
```

```ts
type PersonData = {
  name: string;
  note?: string;
  aliases?: string[];
};
```

```ts
type TodoPersonRole = "waiting_on" | "related";

type TodoPersonRef = {
  todo_id: string;
  person_id: string;
  role: TodoPersonRole;
};
```

Workspace default:

```ts
type WorkspaceSettings = {
  default_project_review_anchor: {
    weekday: 0;
    time: "20:00";
  };
};
```

## Persistence

Use the existing `entities` / `entity_revisions` tables for current Entity JSON state.

Add a Todo-specific association table:

```sql
CREATE TABLE todo_person_refs (
  todo_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  person_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('waiting_on','related')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (todo_id, person_id)
);

CREATE INDEX idx_todo_person_refs_person
  ON todo_person_refs(person_id);

CREATE INDEX idx_todo_person_refs_role
  ON todo_person_refs(role);
```

Core invariants, enforced in validators/apply paths:

- `todo_id` must point to an Accepted Entity of type `todo`.
- `person_id` must point to an Accepted Entity of type `person`.
- Exactly one row per `(todo_id, person_id)`.
- `waiting_on` includes related semantics; do not add a second `related` row for the same Person.
- Role is required. UI/Worker may default missing role to `related` before submit.

`Todo.project_id` remains inside Todo JSON because V1 allows at most one owning Project.

Project deletion behavior:

```text
delete Project
  -> unset project_id on affected Todos
  -> write Todo revisions for changed Todos
  -> active affected Todos may appear in Inbox if no due date and no Person refs remain
```

Person deletion behavior:

```text
delete Person
  -> cascade/remove TodoPersonRef rows
  -> active affected Todos may appear in Inbox if no project and no due date and no Person refs remain
  -> Todo title/note text remains unchanged
```

## Validation

Todo validation:

- `title` is required and non-empty after trim.
- `note` is optional string.
- `status` is one of `active`, `completed`, `dropped`.
- `project_id`, when present, must point to an Accepted Project.
- `defer_at`, `due_at`, `completed_at`, `dropped_at`, when present, must be parseable concrete timestamps.
- `status === "active"` requires `completed_at` and `dropped_at` to be absent.
- `status === "completed"` requires `completed_at` present and `dropped_at` absent.
- `status === "dropped"` requires `dropped_at` present and `completed_at` absent.
- Todo V1 must reject `repeat`, `inbox`, `standalone`, `blocked`, `on_hold`, subtasks, action groups, and generic tags.

Project validation:

- `name` is required and non-empty after trim.
- `outcome` and `note` are optional strings.
- `status` is one of `active`, `on_hold`, `completed`, `dropped`.
- `defer_at`, `due_at`, `completed_at`, `dropped_at`, `next_review_at`, `last_reviewed_at`, when present, must be parseable concrete timestamps.
- `status === "active"` or `status === "on_hold"` requires `completed_at` and `dropped_at` to be absent.
- `status === "completed"` requires `completed_at` present and `dropped_at` absent.
- `status === "dropped"` requires `dropped_at` present and `completed_at` absent.
- `review_every`, when present, requires a positive integer interval and unit `day | week | month | year`.
- New active Projects should receive default review fields unless explicitly supplied by direct user edit.
- Reject `type`, `person_ids`, `todo_ids`, direct POC fields, generic tags, and action-group fields.

Person validation:

- `name` is required and non-empty after trim.
- `note` is optional string.
- `aliases` is optional array of non-empty strings.
- Reject status/lifecycle/task/project embedded fields in V1.

## Derived Facets

Todo availability:

```ts
is_available =
  todo.status === "active" &&
  (todo.defer_at == null || todo.defer_at <= now);
```

Todo due facets:

```ts
is_overdue =
  todo.status === "active" &&
  todo.due_at != null &&
  todo.due_at < now;

is_due_soon =
  todo.status === "active" &&
  todo.due_at != null &&
  todo.due_at <= horizon;
```

Waiting/follow-up:

```ts
is_waiting =
  todo.status === "active" &&
  exists TodoPersonRef(todo_id = todo.id, role = "waiting_on");
```

Inbox:

```ts
is_inbox_todo =
  todo.status === "active" &&
  todo.project_id == null &&
  todo.due_at == null &&
  hasNoTodoPersonRefs(todo.id);
```

Inbox Todos may have:

```text
title
note
defer_at
```

They leave Inbox when any of these appear:

```text
project_id
due_at
TodoPersonRef
```

This is intentionally awkward for one-off errands like "buy milk" in V1. Those remain Inbox until future Tags/Contexts exist.

## Project Review Rules

Default for newly created active Projects:

```ts
review_every = { interval: 1, unit: "week" };
next_review_at = nextSundayAt2000Local(created_at);
last_reviewed_at = undefined;
```

Reviewable Projects:

```ts
status === "active" || status === "on_hold"
```

Not reviewable:

```ts
status === "completed" || status === "dropped"
```

Mark reviewed:

```ts
last_reviewed_at = now;
next_review_at = nextSundayAt2000LocalAfter(now);
```

If reviewed after Sunday 20:00 local, the next review is the following Sunday 20:00 local.

`review_every` is stored per Project. The first UI can expose only the default weekly review ritual. If custom review intervals are allowed before a custom scheduler exists, treat `next_review_at` as authoritative and do not infer unsupported cadence behavior in the UI.

## Proposal Mutations

Worker-originated mutations use the Proposal path. Direct user CRUD applies directly through Core.

Needed Workspace mutation kinds:

```ts
type WorkspaceMutationKind =
  | "create_person"
  | "update_person"
  | "delete_person"
  | "create_project"
  | "update_project"
  | "delete_project"
  | "create_todo"
  | "update_todo"
  | "delete_todo";
```

Todo create/update payloads include associated context so one accepted Todo mutation can write Todo JSON plus Todo Person References atomically:

```ts
type TodoPersonRefPatch = {
  person_id: string;
  role: "waiting_on" | "related";
};

type CreateTodoPayload = {
  todo: TodoData;
  person_refs?: TodoPersonRefPatch[];
};

type UpdateTodoPayload = {
  todo_id: string;
  todo?: Partial<TodoData>;
  set_person_refs?: TodoPersonRefPatch[];
  add_person_refs?: TodoPersonRefPatch[];
  remove_person_ids?: string[];
};
```

`project_id` lives in `todo.project_id`; do not create a Todo-Project join table.

When setting `set_person_refs`, replace the full Todo Person Reference set for that Todo in the same transaction as the Todo revision. When adding/removing individual refs, preserve unique `(todo_id, person_id)`.

Missing Project/Person enrichment sequence:

```text
1. create Todo
2. find missing Project/Person
3. propose create missing Entity
4. if accepted, propose Todo update with project_id/person_refs
5. if rejected, skip that link
```

Do not link to unaccepted Entities.

## Capture Flows

### Direct Todo capture

Input:

```text
Remind me to follow up with Alice next Monday about Project Y.
```

Expected flow:

```text
1. Worker proposes create_todo sourced from Message.
2. Core accepts or surfaces Proposal.
3. Accepted Todo is created with title/note/status/defer_at/due_at/project_id only when known.
4. Worker searches existing Project and Person Entities.
5. Existing Project/Person links are proposed through Todo update.
6. Missing Project/Person are proposed one at a time, then linked only if accepted.
```

No Journal Entry is required.

### Vague direct Todo capture

Input:

```text
Make code changes.
```

Expected flow:

```text
create Todo:
  title = "Make code changes"
  status = "active"
  no project_id
  no due_at
  no TodoPersonRefs
```

Derived result:

```text
Inbox Todo
```

The Workflow may ask follow-up questions before or after creation, but the Todo schema does not store `inbox`.

### JournalEntry-derived Todo

Input:

```text
10:30 talked to Alice about Project Y, need to follow up Friday.
```

Expected flow:

```text
1. Message -> JournalEntry Proposal.
2. Accepted JournalEntry stores event body/time.
3. Worker proposes Todo sourced from JournalEntry.
4. Accepted Todo may be enriched with Project and Person refs.
5. JournalEntry may be patched with an EntityRef to the Todo if the action is represented inline.
```

No blanket copy from JournalEntry Person refs to Todo Person References. The Worker must propose Todo Person References based on the Todo's actual semantics.

### Direct Project capture

Input:

```text
Start a project for API v2 migration.
```

Expected flow:

```text
Message -> create_project Proposal
```

No Todo or JournalEntry is required.

### Direct Person capture

Input:

```text
Remember Alice is the daycare coordinator.
```

Expected flow:

```text
Message -> create_person Proposal
```

No Todo or JournalEntry is required unless the Message is also a journal-worthy event.

## EntitySource Rules

Direct non-journal capture:

```text
Message -> Person relation created_from
Message -> Project relation created_from
Message -> Todo relation created_from
```

Journal extraction:

```text
JournalEntry -> Person relation created_from
JournalEntry -> Project relation created_from
JournalEntry -> Todo relation created_from
```

Later user edits/refinements:

```text
Message -> Entity relation updated_from
```

Assistant Messages are not Entity Sources.

## EntityRef Rules

EntityRef is only for JournalEntry inline body references in V1.

Todo title/note, Project note, Project outcome, and Person note are plain text. They do not contain structured body nodes or inline refs.

JournalEntry can inline-reference a Todo:

```text
EntitySource: JournalEntry -> Todo
EntityRef: JournalEntry body node -> Todo
```

These answer different questions:

- EntitySource: why does the Todo exist?
- EntityRef: where is the Todo mentioned inline?

## Views

Todo page:

- show Todo fields
- show Project if `project_id` exists
- show linked People from TodoPersonRef
- show Created from via EntitySource
- show Mentioned in JournalEntries via EntityRef where target is Todo

Person page:

- show Person fields
- show Tasks through TodoPersonRef
- show Waiting/Follow-up tasks where role is `waiting_on`
- show Projects through TodoPersonRef -> Todo -> Project
- show Journal history through EntityRef where target is Person

Project page:

- show Project fields
- show Todos where `Todo.project_id` is Project
- show People through those Todos' TodoPersonRefs
- show review state
- show stalled/no-active-task indicators as review signals only; do not auto-complete

Inbox view:

- pending Proposals
- parked Threads/Runs needing user action
- active Inbox Todos derived by the rule above
- future JournalEntry follow-up/detail states if implemented

Review view:

- active and on-hold Projects with `next_review_at <= now`
- group on-hold separately from active
- completed/dropped Projects excluded

Waiting/Follow-up view:

- active Todos with TodoPersonRef role `waiting_on`
- `defer_at` only controls whether the Todo is available now; it does not remove the Todo from this view unless the view explicitly filters unavailable items

## V0: Persistence Foundation

V0 creates durable state and validation only. It should be useful even before any Worker extraction, Inbox UI, or Review UI exists.

### V0.1 Entity validators

- Add/update validators for `person`, `project`, and `todo`.
- Reject fields outside the V1 shapes.
- Validate status/timestamp invariants.
- Default new Todo status to `active` when appropriate.
- Default new Project status to `active` when appropriate.
- Default new active Project review metadata.
- Keep Todo recurrence absent: reject `repeat`.
- Keep Todo Inbox absent: reject `inbox` and `standalone`.

Verify:

- unit tests for valid and invalid Todo payloads
- unit tests for valid and invalid Project payloads
- unit tests for valid and invalid Person payloads
- proposal edit path re-runs validators before apply

### V0.2 Todo Person Reference persistence

- Add `todo_person_refs`.
- Add DB helpers to list refs by Todo.
- Add DB helpers to list refs by Person.
- Add DB helpers to list Todos by Person role.
- Add apply helpers to set/add/remove refs transactionally.
- Enforce accepted `todo` and accepted `person` targets in Core apply code.

Verify:

- duplicate `(todo_id, person_id)` rejected or upserted deterministically
- invalid `todo_id` target type rejected
- invalid `person_id` target type rejected
- deleting Todo removes refs
- deleting Person removes refs

### V0.3 Workspace mutation apply paths

- Add mutation kinds for Person/Project/Todo create/update/delete.
- Create/update Todo can atomically update Todo JSON and TodoPersonRefs.
- Delete Project unsets `project_id` on affected Todos and writes Todo revisions.
- Delete Person removes TodoPersonRefs.
- Delete Todo removes TodoPersonRefs.
- Apply EntitySource rows for direct Message capture and JournalEntry extraction.
- Preserve one Proposal equals one logical mutation; one accepted mutation may write multiple rows atomically.

Verify:

- accepted create/update/delete Proposal writes all rows in one transaction
- rejected Proposal writes none
- edit Decision validates edited payload
- direct user CRUD uses same validators but bypasses Proposal
- Todo update and TodoPersonRef changes cannot partially apply

### V0.4 Read helpers and derived predicates

- Add low-level helpers for `is_available`, `is_overdue`, `is_due_soon`, `is_waiting`, and `is_inbox_todo`.
- Add data-access helpers for:
  - Todo by Project
  - Todo by Person
  - Person refs by Todo
  - Project's People via TodoPersonRefs
  - Person's Projects via TodoPersonRefs
  - Projects due for review
- These helpers may stay Core-internal in V0; V1 can expose them through UI-facing APIs.

Verify:

- `buy milk` is Inbox in V1 terms: active, no Project, no due date, no Person refs
- Todo with due date is not Inbox
- Todo with Project is not Inbox
- Todo with Person ref is not Inbox
- `waiting_on` shows as waiting but does not change availability
- Project people derive only through Project Todos

### V0.5 Persistence handoff criteria

V0 is done when another implementation thread can rely on:

```text
entities.data validates Todo/Project/Person shapes
todo_person_refs stores Todo -> Person roles
EntitySource can point Message/JournalEntry -> Todo/Project/Person
Project deletion unsets Todo.project_id
Person deletion removes TodoPersonRefs
Todo predicates are test-covered
```

V0 does not need:

- Worker prompt changes
- search/enrichment chain
- Inbox UI
- Review UI
- Person/Project detail UI
- direct chat capture UX

## V1: Product and Workflow Layer

V1 uses V0's durable model to make the system useful in chat and UI.

### V1.1 Worker/search enrichment flow

- Worker creates Todo first.
- Worker searches existing Person/Project Entities.
- Existing links become Todo update proposals.
- Missing Person/Project become create proposals first, then Todo update proposals if accepted.
- Rejected create proposals skip links.

Verify:

- direct Todo with existing Alice links Alice
- direct Todo with missing Alice proposes Alice before linking
- rejection leaves Todo valid and unlinked
- JournalEntry-derived Todo does not copy unrelated JournalEntry Person refs

### V1.2 Direct capture workflows

- Direct Todo capture can create Todo from Message.
- Direct Project capture can create Project from Message.
- Direct Person capture can create Person from Message.
- Non-journal capture must not create fake Journal Entries.
- Journal-worthy event capture still follows ADR-0030.

Verify:

- "Remind me to buy milk" proposes a Todo sourced from Message
- "Start a project for API v2 migration" proposes a Project sourced from Message
- "Remember Alice is the daycare coordinator" proposes a Person sourced from Message
- "10:30 talked to Alice..." proposes JournalEntry first

### V1.3 Derived views

- Add UI/API surface for Inbox Todos.
- Add UI/API surface for Waiting/Follow-up Todos.
- Add UI/API surface for Person page tasks/projects.
- Add UI/API surface for Project page tasks/people.
- Add UI/API surface for Project Review.

Verify:

- Inbox renders active Todos with no Project, no due date, no Person refs
- Waiting/Follow-up renders active Todos with `waiting_on`
- Person page derives Projects through TodoPersonRef -> Todo -> Project
- Project page derives People through Todo -> TodoPersonRef -> Person
- Review excludes completed/dropped Projects and includes active/on-hold Projects

### V1.4 UI editing

- Todo create/edit form supports title, note, status, project, defer date, due date, linked People and roles.
- Person detail shows tasks, waiting tasks, projects, and journal history.
- Project detail shows tasks, people through tasks, and review metadata.
- Inbox renders derived Todo items plus existing pending/parked work.
- Review view supports marking Project reviewed.

Verify:

- direct user edits apply without Proposal
- Worker-originated mutations surface/auto-approve through Proposal policy
- review mark advances to next Sunday 20:00 local

### V1.5 JournalEntry integration

- JournalEntry-derived Todos can source from JournalEntry.
- JournalEntry body may inline-reference accepted Todo through EntityRef.
- No blanket copy from JournalEntry Person refs to TodoPersonRefs.
- Todo detail can show Created from through EntitySource and Mentioned in through EntityRef.

Verify:

- accepted JournalEntry can source a Todo
- rejected Todo Proposal creates no Todo and no EntityRef
- TodoPersonRefs are proposed only for people relevant to that Todo
- Todo page distinguishes Created from vs Mentioned in

## Out of Scope

- Todo recurrence storage and execution. See #124 and #125.
- Generic Tags/Contexts.
- Location/tool/energy contexts such as office, phone, home, errands.
- Subtasks/action groups.
- Direct Project-Person references.
- Multi-project Todos.
- Inline structured nodes in Todo/Project/Person text fields.
- Automatic follow-up creation on Todo completion.
- Automatic Project completion when all Todos are done.

## Handoff Checklist

Before implementation starts, confirm these files are read:

- `CONTEXT.md`
- `docs/adr/0030-journal-entry-anchored-capture.md`
- `docs/adr/0031-gtd-todo-person-project-model.md`
- `docs/plans/journal-entry-capture-plan.md`
- `docs/plans/gtd-todo-person-project-plan.md`

If implementing V0, stop at the V0 persistence handoff criteria. Do not add Worker extraction behavior, Inbox UI, Review UI, or Person/Project detail projections in the V0 branch.

If implementing V1, verify the V0 handoff criteria first. V1 should consume V0 validators, persistence helpers, mutation apply paths, and derived predicates instead of reimplementing relationship logic in UI or Worker code.

Implementation should preserve the central distinction:

```text
JournalEntry EntityRef = inline prose reference
TodoPersonRef = task/person relationship
EntitySource = provenance
Todo.project_id = owning GTD outcome
Inbox = derived raw Todo view
```
