# Journal Entries anchor chat capture; Daily Notes are derived views

Inkstone's chat input serves two different user intents: ordinary conversation and interstitial journaling. A journal-worthy Message should not immediately create a loose set of Person, Project, and Todo Entities. It first becomes a Journal Entry, and the accepted Journal Entry becomes the evidence anchor for any structured Entities extracted from it.

## Decision

Add **Journal Entry** as an Entity Type. A Journal Entry is the canonical event/evidence record refined from one or more user source Messages. One user Message may produce multiple Journal Entries, and one Journal Entry may later be refined by user Messages. Person, Project, and Todo Entities extracted from a journal flow source from the accepted Journal Entry, not directly from the raw chat Message.

The first Journal Entry intake implementation intentionally limits update/delete to the original Thread: Core accepts an update/delete only when the target Journal Entry has a `created_from` Entity Source whose source user Message belongs to the current Thread. Cross-Thread refinement remains part of the long-term domain model, but is deferred until the Workflow has a dedicated disambiguation/search path for safely selecting entries outside the current Thread.

Add two first-class domain associations:

- **Entity Source**: provenance/evidence, answering "why does this Entity exist?"
- **Entity Reference**: an inline Journal Entry reference to an Accepted Entity, answering "which Entity does this part of the entry refer to?"

Keep **Daily Note** out of the Entity model. A Daily Note is a derived date-grouped view over Journal Entries. Future daily or weekly rewind outputs can be saved as their own review/synthesis Entities if they become user-authored artifacts, but the date bucket itself is not authoritative content.

## Why Journal Entry first

The raw Message is an input artifact: it records what the user typed into chat. The Journal Entry is the accepted event record: it stores the refined wording and time context the user wants Inkstone to remember. Creating extracted structured Entities before this anchor would leave Person, Project, and Todo records sourced from chat bubbles rather than from the user's accepted journal record.

Anchoring extraction on Journal Entry also keeps rejection behavior clear. If an extracted Person or Project Proposal is rejected, the Journal Entry remains intact; the rejected Entity and its references do not land.

## Why Daily Note is derived

A Daily Note is a grouping of Journal Entries by local day using each entry's occurred time. Persisting it as authoritative content creates synchronization questions: if an entry is edited, moved to another time, references a Person, or deleted, the daily document would need a separate reconciliation model. Deriving the Daily Note from Journal Entries avoids that duplicate authority.

This does not preclude fast rendering. If daily or weekly rewind becomes expensive, a tier-3 projection/cache can materialize rendered daily views and invalidate them from Journal Entry changes. The canonical data remains the entries, sources, and references.

## Proposal flow

Worker-originated mutations continue through the Proposal policy from [ADR-0016](./0016-proposal-application-policy.md). The journal capture flow is sequential:

1. The Dispatcher/Router classifies a Message as journal-worthy.
2. The Worker proposes one or more Journal Entries.
3. After a Journal Entry is accepted, the Worker extracts candidate Person, Project, and Todo Entities from that Journal Entry.
4. The Worker proposes one mutation at a time.
5. Core decides per Proposal whether to auto-approve or surface it to the Web Client.
6. Accepted extracted Entities record the Journal Entry as their Entity Source, and Journal Entry body refs point to accepted Entities through Entity References.

The one-at-a-time Proposal shape remains aligned with [ADR-0025](./0025-proposal-park-and-resume.md). This ADR does not introduce batched Proposals.

Assistant Messages may provide conversational context for a Workflow, but Entity Sources point to user-provided evidence. If later user Messages refine an existing Journal Entry, the latest accepted update wins; conflict detection and explanation are Workflow behavior, not a Journal Entry state machine.

## Consequences

- Search and backlinks should query Entity References instead of scanning journal prose for names.
- Person, Project, and Todo Entities are not mere projections of Journal Entries. They may originate from a Journal Entry, but once accepted they own their current structured state.
- Journal Entries are more authoritative as event/evidence records, not as the current state of every extracted Entity.
- Daily Note rendering is a Client/export concern over accepted Journal Entries and reference data.
- Cross-Thread refinement is allowed in the long-term model through additional user Message Entity Sources; the first intake implementation defers it and only permits update/delete from the Thread that originally created the Journal Entry.
- Existing chat-driven architecture stays intact: Message starts a Run; Workflow proposes Workspace changes; Core applies accepted Proposals atomically.

## Considered and rejected

- **Use Messages as the only journal source.** Rejected: ordinary chat and journal capture share the same input surface, and raw chat text is not the refined event record the user wants to keep.
- **Create Person/Project/Todo directly from Messages.** Rejected: loses the accepted Journal Entry as provenance and makes later "why does this entity exist?" queries point at chat implementation artifacts.
- **Make Daily Note an Entity.** Rejected for the first model: the daily bucket is a collection view over entries, not independent source content.
- **Store unresolved mentions as canonical state.** Rejected: unaccepted extraction output is speculative and belongs as tier-3 candidate/projection data until ratified through a Proposal.
- **Batch Journal Entry and extracted Entities into one Proposal.** Rejected for now: ADR-0025 deliberately keeps one Proposal as one decision.

## Related

- [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md) — chat remains the first capture surface.
- [ADR-0011](./0011-per-run-workflow-dispatch.md) — per-Run dispatch allows journal capture and ordinary chat to share a Thread.
- [ADR-0016](./0016-proposal-application-policy.md) — Worker-originated Workspace mutations go through Proposals.
- [ADR-0017](./0017-tier-2-schema-slice-1.md) — Entities and revisions are canonical tier-2 state.
- [ADR-0025](./0025-proposal-park-and-resume.md) — Proposals park/resume one decision at a time.
