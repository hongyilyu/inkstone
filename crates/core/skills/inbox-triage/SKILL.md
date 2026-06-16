---
name: inbox-triage
description: >-
  Triage loosely-captured Todos — find active Todos with no Project, no dates,
  or a vague title, and propose clarifying updates one at a time. Use when the
  user asks to triage, clean up, clarify, or process their todos or inbox.
---

# Inbox triage

Triage turns a pile of half-formed captures into Todos that are actually
actionable: each one says what to do, belongs to the right Project, and has a
date if it needs one. Work the list one Todo at a time, the user deciding each.

1. Call `search_entities` for the user's active Todos. An empty result means the
   inbox is already clear — say so and stop.
2. Flag the Todos that need clarifying: a vague title that doesn't name a
   concrete action, no linked Project where one obviously applies, or a missing
   `due_at`/`defer_at` the user clearly intended. Leave well-formed Todos alone.
3. Take the flagged Todos one at a time. For each, ask the user the single
   question that resolves it — what's the real next action, which Project it
   belongs to, when it's due.
4. Turn the answer into exactly one `update_todo` proposal via
   `propose_workspace_mutation`: rewrite the title to a concrete action, set
   `payload.todo.project_id` to link a Project, or set the date. To link a
   Project that doesn't exist yet, first propose `create_project`, and only link
   it once that create is accepted. Wait for each decision before the next Todo.
5. When the flagged Todos are processed, summarize what was clarified and what
   you left untouched.

Propose one mutation per turn and only touch Todos the user is triaging now. If
the user rejects an update, leave the Todo unchanged and move on.
