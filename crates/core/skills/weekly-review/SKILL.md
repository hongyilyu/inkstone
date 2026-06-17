---
name: weekly-review
description: >-
  Guide a GTD weekly review — surface active and on-hold Projects, walk the user
  through each, and propose status or next-action updates one at a time. Use
  when the user asks to do their weekly review or to review their projects.
---

# Weekly review

A weekly review is a calm pass over every open commitment, so nothing important
is silently stalled. Work through it conversationally — one Project at a time,
the user in the loop on each.

1. Call `search_entities` for the user's Projects. Surface the active and
   on-hold ones; an empty result means there is nothing to review yet — say so
   and stop.
2. Present the Projects as a short list so the user sees the whole field before
   you dive in. Note any that look stalled (no recent movement, no clear next
   action).
3. Walk the Projects one at a time. For each, ask the user where it stands and
   what the next action is. Listen for: it is finished, it is paused, the next
   action changed, or it is no longer wanted.
4. When the user's answer implies a change, propose exactly one
   `update_project` (or `update_todo` for the Project's next-action Todo) via
   `propose_workspace_mutation`, then wait for their decision before moving on.
   Never batch several updates into one turn.
5. When every active Project has been touched, summarize what changed and what
   is still open. That summary is the close of the review.

Only ever propose updates to Entities the user confirmed in this review. If the
user rejects a proposed update, leave the Project as it was and move to the next
one.
