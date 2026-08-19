# Task ownership moves to TickTick: native Todo retirement + two external read paths

Status: Accepted

> **Amended in part by [ADR-0065](./0065-ticktick-task-creation-through-the-proposal-gate.md).**
> "No task writes" held only until the write feature landed: Inkstone now
> **creates** a task through the Proposal gate (create only — no complete,
> update, delete, or user-direct write), so the prompt no longer redirects a
> reminder to "add it in TickTick yourself". Everything else here stands:
> TickTick is the sole task authority, the two read lanes are unchanged, and
> Core still stores no task row.

/ supersedes in part [ADR-0031](./0031-gtd-todo-person-project-model.md), [ADR-0032](./0032-gtd-relations-on-entity-list.md), [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md), [ADR-0042](./0042-intent-graph-journal-extraction.md), [ADR-0050](./0050-entity-backlinks-read-seam.md), [ADR-0055](./0055-gtd-ownership-and-relation-model.md)
/ supersedes [ADR-0037](./0037-todo-recurrence-rule.md), [ADR-0039](./0039-recurring-todo-occurrence-generation.md)
/ builds on [ADR-0018](./0018-workflow-and-tools-definition.md), [ADR-0023](./0023-provider-oauth-core-owned-credentials.md), [ADR-0025](./0025-proposal-park-and-resume.md)

Inkstone built a native GTD task model — Todo/Person/Project entities, Todo Person
References, recurrence rules and successor generation, Project Review, and a set of
GTD processing views (Inbox / Waiting / Scheduled / Today). It works, but the user
already runs their tasks in TickTick, and a second task system that neither syncs
nor wins is worse than none: every "remind me to…" forces a choice about which app
is authoritative, and the honest answer was always "the one you actually check."

This ADR makes that answer the design. TickTick becomes the sole task authority.
Inkstone keeps the two GTD entities that are *not* tasks — **Person** and
**Project** (an outcome with a review cadence) — and retires the Todo entirely.
Tasks reach Inkstone through two READ-ONLY lanes; Inkstone never writes a task.

## Decision

**Retire the native Todo.** Gone from Core: the `Todo` Entity Type (its
`create_todo`/`update_todo`/`delete_todo` mutation kinds, payload specs, and
proposal descriptor variants), the Recurrence Rule + occurrence generation
(ADR-0037/0039 in full), Todo Person References (the `todo_person_refs` table,
dropped by editing the initial migration in place — AGENTS.md §5, pre-release),
and every todo read/derivation (`todos_by_project`/`_by_person`, the intent-graph
`todo` node + `todo_project`/`todo_person` links). The agent-proposable set drops
from 15 to 12 kinds; the intent graph resolves only Person/Project nodes joined by
`journal_ref` links.

**Retire the GTD processing surface.** Gone from Web: the GTD Topic + route,
`GtdView`/`DerivedTodoView`/`TodoEditor`, the Inbox/Waiting/Scheduled/Today-todo
derivations, todo facets (date + person), and the `recurrence/preview` verb. The
`Tasks` Topic (the S2 read-only TickTick surface, `/library/tasks`) takes GTD's
place in the nav. **Project Review relocates to the Project surface** (`?review`
on `/library/projects`) — it is a Project ritual, not a todo one, and survives
whole.

**Two read-only task lanes** (built in S2/S3, exposed here):
- **Web → Core → TickTick OpenAPI.** Core owns a `ticktick/*` client (boot-read
  credentials, opaque connection id, a fixed 200-entry read); the Tasks surface
  reads it through `ticktick/status` + `ticktick/tasks/list`.
- **Worker → TickTick MCP.** The default Workflow's manifest now carries the MCP
  endpoint + auth (`external_tools = true`), so the model can answer questions
  about the user's tasks via the namespaced `ticktick_*` read tools. Discovery
  and a pre-execution gate both enforce a read-only allowlist; a write tool is
  absent from discovery AND rejected at the gate. External calls surface as
  expand-on-demand transcript rows (ADR-0042's `TranscriptToolResult`), never
  grouped, credentials never rendered.

**No task writes.** Chat task capture dies at cutover: "remind me to buy milk"
produces no tracked task anywhere. The agent's honest move is to tell the user to
add it in TickTick. The default Workflow prompt says exactly that and proposes no
mutation for a reminder/task. *(Amended by ADR-0065: a reminder now becomes one
`propose_ticktick_task` Proposal, and the prompt says THAT. The rest of this
decision — no complete/update/delete, no user-direct writes, no task rows —
stands.)*

## Consequences

- **The dual-authority problem is gone.** One task system, and it is the one the
  user checks. Inkstone reads tasks; it never competes to own them.
- **A capability is deliberately removed.** Until a future write feature, Inkstone
  cannot create or edit a task. This is the agreed cost — an honest redirect beats
  a task that lands in a system the user has abandoned. *(That future feature is
  ADR-0065: create returned through the Proposal gate; edit/complete/delete did
  not.)*
- **Person and Project stay first-class.** Extraction still proposes them; Project
  Review still runs. Only the task half of the GTD model retired.
- **Schema churn, not migration.** Pre-release (AGENTS.md §5), so `todo_person_refs`
  and the todo vocabulary were edited out of the initial migration in place rather
  than patched forward. A dev DB predating the cutover is reset, not migrated.
- **Reads can go stale / hit TickTick's 200-item cap.** The Web surface flags the
  cap; both lanes fail soft (a Core-unreachable read degrades, an MCP error
  persists as an error row) rather than fabricating tasks.

## Related

- [ADR-0031](./0031-gtd-todo-person-project-model.md) — the GTD model this retires
  the Todo half of; Person/Project survive.
- [ADR-0037](./0037-todo-recurrence-rule.md), [ADR-0039](./0039-recurring-todo-occurrence-generation.md)
  — recurrence, retired whole with the Todo.
- [ADR-0055](./0055-gtd-ownership-and-relation-model.md) — the GTD ownership/relation
  read; its todo-ownership half retires, the Project relation reads survive.
- [ADR-0042](./0042-intent-graph-journal-extraction.md) — the intent graph, now Person/Project +
  `journal_ref` only.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — the Workflow manifest that
  carries the external-tool endpoint + auth.
