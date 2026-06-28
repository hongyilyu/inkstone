# GTD Todo, Person, and Project entity model

Inkstone's chat surface captures both journal events and operational commitments. ADR-0030 defines how event capture becomes Journal Entries first. This ADR defines the V1 data model for the actionable side: Todo, Person, and Project, following GTD and the parts of OmniFocus that fit Inkstone's Entity model.

OmniFocus is the reference product shape: actions belong to projects, actions can carry contextual tags, defer dates control when work becomes available, due dates are hard deadlines, and projects are reviewed periodically. Inkstone differs by making Person a first-class Entity instead of treating people as generic tags. Generic tags/contexts such as home, phone, office, energy, or errands are deferred.

## Decision

Add V1 domain models for **Todo**, **Project**, **Person**, and **Todo Person Reference**.

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
type ProjectStatus = "active" | "on_hold" | "completed" | "dropped";

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
type TodoPersonRef = {
  todo_id: string;
  person_id: string;
  role: "waiting_on" | "related";
};
```

## Todo semantics

A Todo is a user-owned actionable commitment. Even when another person is involved, Inkstone tracks what the user needs to do, wait on, or follow up about. "Bob aligns on Z" is not a normal Todo unless it is framed as something the user is tracking, such as "Follow up with Bob about Z" or "Wait for Bob to align on Z."

`defer_at` and `due_at` have different meanings:

- `defer_at`: when the Todo starts/resurfaces. It is the "not before" date.
- `due_at`: a real deadline. It is not a soft planning date.

Availability is derived, not stored:

```ts
is_available =
  status === "active" &&
  (defer_at == null || defer_at <= now);
```

Due facets are independent:

```ts
is_overdue = status === "active" && due_at != null && due_at < now;
is_due_soon = status === "active" && due_at != null && due_at <= horizon;
```

Waiting/follow-up is a view over Todo Person References:

```ts
is_waiting = status === "active" && has TodoPersonRef(role = "waiting_on");
```

`waiting_on` does not hide a Todo and does not change availability. It means the Todo is relevant to a waiting/follow-up perspective and to the linked Person view.

Todos do not have `on_hold` status. A single task that should not be shown yet uses `defer_at`; a task involving another person uses Todo Person Reference. Project status keeps `on_hold` because a whole outcome can intentionally be paused without a concrete resume date.

## Project semantics

A Project is a GTD outcome, not a category or area. It is something the user wants to bring to a completed state and may require more than one Todo.

Project examples:

- "Ship API v2 migration"
- "Move daycare schedule to new provider"
- "Plan Lisbon trip"

Non-examples:

- "Alice"
- "Health"
- "Work"
- "Home"

Projects do not directly link to People in V1. Third-party involvement in a Project is represented by Todos under that Project with Todo Person References. Therefore:

```text
Project people = Project -> Todos -> TodoPersonRef -> Person
Person projects = Person -> TodoPersonRef -> Todo -> Project
```

Project completion is manual only. A Project with no remaining active Todos may be completed, stalled, waiting, or no longer relevant; Review should surface it, not mutate it automatically.

## Person semantics

Person stays descriptive in V1. It is not a CRM record and it does not own task/project fields. The Person page is derived from references:

```text
Tasks / Projects:
Person -> TodoPersonRef -> Todo -> Project

Journal history:
Person <- EntityRef <- JournalEntry
```

Deleting a Person removes Todo Person References to that Person. Todo `title` and `note` remain unchanged because Todo text is plain text. Affected active Todos naturally re-enter Inbox only if they now have no Project, no due date, and no remaining Todo Person References.

## Todo Person Reference

Todo Person Reference is a task-specific association, not a generic relationship graph and not an Entity Reference.

- Entity Reference renders inline Journal Entry body nodes.
- Todo Person Reference records Person involvement in a Todo.
- `Todo.project_id` records the Todo's owning Project.

`TodoPersonRef` is a real association object/table because one Todo can mention several People with different roles:

```ts
[
  { todo_id: "todo_1", person_id: "alice", role: "waiting_on" },
  { todo_id: "todo_1", person_id: "bob", role: "related" },
  { todo_id: "todo_1", person_id: "eve", role: "related" },
]
```

There is at most one Todo Person Reference per `(todo_id, person_id)`. The role is required. If unspecified by UI or Worker, it defaults to `related`. `waiting_on` includes related semantics; do not store a duplicate `related` row for the same Person.

Todo Person References only point to Accepted Person Entities. If a Worker wants to link a missing Person, it proposes Person creation first. If the user rejects that Person, the Todo remains valid and the name stays as plain text in the Todo title or note.

## Inbox

Inbox is a derived processing view, not an Entity and not a Todo field.

In V1:

```ts
is_inbox_todo =
  status === "active" &&
  project_id == null &&
  due_at == null &&
  hasNoTodoPersonRefs;
```

An Inbox Todo may still have:

```ts
title
note?
defer_at?
```

Adding any of the following moves it out of Inbox:

```ts
project_id
due_at
TodoPersonRef
```

This intentionally means a simple one-off task such as "buy milk" remains Inbox in V1 unless it gets a Project, due date, or Person. That is an accepted limitation while generic Tags/Contexts are out of scope. Future Tags/Contexts can move errands and location/tool/energy-specific one-off actions out of Inbox.

## Project Review

Project Review is in V1. It is simpler than Todo recurrence.

Workspace default:

```ts
default_project_review_anchor = {
  weekday: 0,
  time: "20:00",
};
```

New active Projects default to:

```ts
review_every: { interval: 1, unit: "week" }
next_review_at: next Sunday 20:00 local
last_reviewed_at: undefined
```

Active and on-hold Projects are reviewable. Completed and dropped Projects are not reviewable.

Marking a Project reviewed sets:

```ts
last_reviewed_at = now
next_review_at = next upcoming Sunday 20:00 local
```

If the Project is reviewed after Sunday 20:00 local, the next review is the following Sunday 20:00 local.

`review_every` remains per Project so future UI can support custom cadence. V1 may expose only the default weekly review ritual while still storing the field.

### Review anchor and timezone

Computing "next Sunday 20:00 local" requires Core to turn `now` (epoch milliseconds) into a local civil date — the first time Core itself derives a local date, since `occurred_at`/`ended_at` are supplied by the Worker. Core today has no date library and stores naive local wall-clock strings (`YYYY-MM-DDTHH:MM:SS`, no offset).

The review anchor is fixed in code: **weekday = Sunday, time = 20:00**. The only configurable input is the timezone, sourced from a Workspace setting:

```text
review_anchor_utc_offset_minutes   (integer, default 0)
```

Core computes the local civil date as `now_ms + offset_minutes`, then advances to the next Sunday 20:00 at that local wall clock, and stores the result as a naive local wall-clock string — matching the `occurred_at` convention. The arithmetic is hand-rolled civil-date math (proleptic Gregorian), mirroring the existing hand-rolled wall-clock *parser*; no date crate is added to Core.

A fixed-offset setting (not an IANA zone) keeps the computation deterministic and testable without host-timezone flakiness, consistent with the single-user local-first stance (ADR-0007). DST transitions and named-zone support are deferred; when a real scheduler needs them, this setting is superseded. `next_review_at` stored on a Project is authoritative regardless of the anchor — the anchor only seeds the default for newly-created active Projects and advances the date on mark-reviewed.

## Capture and proposal flow

Direct Entity creation from chat is allowed:

```text
Message -> Person
Message -> Project
Message -> Todo
```

No fake Journal Entry is required for non-journal capture. For journal/event capture, ADR-0030 still applies:

```text
Message -> JournalEntry -> extracted Person/Project/Todo
```

Worker-originated changes go through Proposal policy. Direct user CRUD does not.

```text
User manual edit -> Core direct mutation
Worker create/update/delete -> Proposal; Core may auto-approve
```

Todo creation is sequenced before enrichment:

```text
create Todo
then link/create Project
then link/create Person refs
```

This keeps the task even if Project or Person enrichment is rejected. Rejected Project or Person proposals create no link.

When a missing Person or Project is needed for Todo enrichment:

```text
1. propose create missing Entity
2. if accepted, propose/update Todo link
3. if rejected, skip the link
```

Todo link changes are part of a Todo create/update mutation payload and apply atomically with the Todo update. Do not create separate standalone relation Proposals for each Todo Person Reference.

For JournalEntry-derived Todos:

```text
JournalEntry accepted
Worker proposes Todo sourced from JournalEntry
accepted Todo may then be enriched with project_id and TodoPersonRefs
JournalEntry may optionally inline-reference the Todo through EntityRef
```

## Sources and references

Entity Source records provenance:

```text
Message -> Todo
Message -> Person
Message -> Project
JournalEntry -> Todo
JournalEntry -> Person
JournalEntry -> Project
```

Entity Reference remains JournalEntry inline body rendering only:

```text
JournalEntry body -> EntityRef -> Person/Project/Todo
```

Todo, Project, and Person titles/notes stay plain text in V1. They do not use Journal Entry body nodes.

Todo detail pages should show provenance through Entity Source. They may also show "mentioned in" Journal Entries through Entity References whose target is the Todo. These are different labels:

- Created from: Entity Source
- Mentioned in: Entity Reference

## Deletion effects

Deleting a Person:

- removes Todo Person References to that Person
- leaves Todo title/note text unchanged
- may cause affected active Todos to appear in Inbox if no Project, due date, or remaining Person refs exist

Deleting a Project:

- unsets `Todo.project_id` for affected Todos
- leaves Todo title/note text unchanged
- may cause affected active Todos to appear in Inbox if no due date or Person refs exist

Completed and dropped Todos remain historical records; deleting linked context removes the pointer but does not rewrite task text.

## Deferred

Todo recurrence was deferred out of this ADR. The durable rule shape is now
defined in [ADR-0037](./0037-todo-recurrence-rule.md): a Todo carries an optional
`recurrence` rule in its data JSON. Occurrence generation — the execution layer
that spawns the next occurrence when a recurring Todo completes — is defined in
[ADR-0039](./0039-recurring-todo-occurrence-generation.md). Tracking:

- [#124](https://github.com/hongyilyu/inkstone/issues/124): design and persist Todo recurrence rules — resolved by ADR-0037.
- [#125](https://github.com/hongyilyu/inkstone/issues/125): generate next Todo occurrence for recurring Todos — resolved by ADR-0039.

Generic Tags/Contexts are deferred. This includes where/tool/energy contexts such as office, phone, home, errands, and similar OmniFocus tags.

Subtasks/action groups are deferred. V1 uses flat Todos under Projects. If a Todo becomes multi-step, promote it to a Project or create multiple Todos.

## Consequences

- Project and Person pages derive relationships from Todo Person References, not from a generic graph.
- Inbox is a view over raw captured active Todos, not a persisted boolean or separate Entity.
- Todo title/note, Project note, and Person note remain easy to edit as plain text.
- Journal Entry remains the only V1 structured prose body with inline Entity References.
- Direct task/contact/project capture can bypass Journal Entry, while event capture still anchors on Journal Entry first.
- Future Tags/Contexts can solve one-off task classification without adding a fake one-off Project or `standalone` field.

## Considered and rejected

- **Store `blocked` as Todo status.** Rejected: availability is derived from active status and `defer_at`; waiting/follow-up is a Todo Person Reference view.
- **Add `on_hold` to Todo.** Rejected: single-task "not now" uses `defer_at`; whole-outcome pause belongs to Project `on_hold`.
- **Add direct Project-Person links.** Rejected: Projects are the user's outcomes; third-party involvement is represented through Todos.
- **Use Entity Reference for Todo-Person relationships.** Rejected: Entity Reference is inline Journal Entry rendering. Todo Person Reference is task semantics.
- **Persist Inbox as `inbox: boolean`.** Rejected: adding Project, due date, or Person should naturally move a task out of Inbox. Inbox is derived from missing organizing metadata.
- **Persist `standalone: boolean`.** Rejected: it only renames `inbox` and pre-solves generic one-off classification before Tags/Contexts exist.
- **Add a fake one-off Project.** Rejected: single actions should not be hidden inside a fake outcome. Future Tags/Contexts are the correct way out of Inbox for one-off errands.
- **Add recurrence fields now.** Rejected at the time: recurrence needs durable rule semantics and execution. The rule shape was tracked separately and is now defined in [ADR-0037](./0037-todo-recurrence-rule.md) (#124); execution is defined in [ADR-0039](./0039-recurring-todo-occurrence-generation.md) (#125).

## Related

- [ADR-0016](./0016-proposal-application-policy.md) - Worker-originated Workspace mutations go through Proposal policy.
- [ADR-0025](./0025-proposal-park-and-resume.md) - one Proposal is one decision; apply may touch multiple rows atomically.
- [ADR-0030](./0030-journal-entry-anchored-capture.md) - journal-worthy events anchor on Journal Entry before extraction.
- [OmniFocus 4 Reference Manual](https://support.omnigroup.com/documentation/omnifocus/universal/4.8.11/en/contents/) - reference product semantics for projects, defer/due dates, review, tags, and recurrence.
- [ADR-0055](./0055-gtd-ownership-and-relation-model.md) - codifies the GTD ownership boundaries (identity tables vs `data` JSON) this model defines, and pins the lifecycle/relation invariants with tests.
