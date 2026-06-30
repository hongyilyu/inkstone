# MVP slice: chat-driven Web Client

> **Amendment.** Capture behavior in this ADR is updated to align with [ADR-0004](./0004-three-tier-storage-authority.md) (SQLite is the single source of truth). External-editor capture is no longer "deferred to a later slice" — it is dropped as an authoring path. All capture flows through the Client → Core surface into tier-2 SQLite.

> **Forward note.** This ADR's "approve before Core applies" rule was later split by [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md): Proposals gate **agent-initiated** writes only; a user editing their own Library writes directly. The slice's surface has also grown well past chat-driven CRUD — [ADR-0056](./0056-habit-tracker-model.md) (Habit), [ADR-0059](./0059-media-entity-type.md) (Media), and [ADR-0054](./0054-topic-navigation-browse-axis.md) (topic-navigation browse axis) all postdate this MVP framing.

The first vertical slice is **chat-driven**: the user opens the Web Client, types a message into a Thread, the Worker drives a Run, and Workspace changes the Worker wants to make are surfaced as Proposals the user approves before Core applies them. The Web Client is the only Client surface in the MVP.

## What's in scope

- A Thread per conversation, persisted in tier 2.
- A Run per user message, persisted in tier 2, executed by the Worker as one or more Turns.
- Run Events streamed Worker → Core → Web Client (text deltas, status, completion, errors).
- Tool Protocol carrying both ordinary tool calls and Proposals (Tool Request → user decision → Tool Result).
- A Proposal review surface inside the Web Client; approve-then-apply per [ADR-0004](./0004-three-tier-storage-authority.md).
- Tier-2 persistence for Threads, Runs, Proposals, and Canonical Entities the slice creates.

## What's out of scope

- **No external-editor capture path.** Authoring content in an outside editor and having Inkstone ingest it is not a supported path (per [ADR-0004](./0004-three-tier-storage-authority.md)); content is authored only through Inkstone into tier-2 SQLite.
- **No Capture Client.** No CLI, no share-sheet, no ingest-only flows.
- **No automations / scheduled Runs.** Every Run is started by a user message.
- **No retrieval-augmented chat.** Reading existing notes is in scope only insofar as the Worker uses tools to do it during a Run; there is no separate "ask my notes" slice.

## Why chat-driven (not capture-driven)

A capture-driven first slice — user types into a file → watcher → background Run → Proposal — was the prior framing. Under [ADR-0004](./0004-three-tier-storage-authority.md) the watcher and ingestion pipeline are removed entirely (SQLite is the single source of truth; there is no authoritative external input to ingest), so that framing is no longer available regardless. The remaining argument for chat-driven is unchanged: a user message is the trigger; the Worker, Tool Protocol, Run Event stream, and Proposal flow are exercised end-to-end on every Run.

## Why Web Client only

The mock on the `ui-mock` branch is a Web Client design. Building a TUI or Capture Client first would force a second Client surface to ship before the one we have UX for is real. The MVP commits to the Web Client and defers other surfaces.

## Considered and rejected

- **Capture-driven slice (file → watcher → Run → Proposal).** Removed by [ADR-0004](./0004-three-tier-storage-authority.md): SQLite is the single source of truth, so there is no authoritative external input, no watcher, and no ingestion path. Captures arrive through the Client → Core surface like any other content.
- **Apply-then-notify with undo (mock's default behavior).** The `ui-mock` branch shows most edits applied automatically with one gated approval. Rejected: contradicts [ADR-0004](./0004-three-tier-storage-authority.md), which makes Proposal-gated Entity creation the rule that prevents tier 3 from silently driving tier 2. A reliable undo for linked Entities is harder than the affordance suggests, and a hybrid policy adds a "which writes are gated" decision the MVP doesn't need.
- **Retrieval-augmented chat as the first slice.** Exercises fewer tier-2 concerns and skips the Proposal flow, which is the architecturally distinctive piece worth proving early.

## Related

- [ADR-0002](./0002-clients-talk-only-to-core.md) — Web Client talks only to Core.
- [ADR-0004](./0004-three-tier-storage-authority.md) — Proposal gating for tier-2 Entity changes.
- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — both channels are exercised in this slice.
