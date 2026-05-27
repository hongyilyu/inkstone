# MVP slice: chat-driven Web Client

The first vertical slice is **chat-driven**: the user opens the Web Client, types a message into a Thread, the Worker drives a Run, and Workspace changes the Worker wants to make are surfaced as Proposals the user approves before Core applies them. The Web Client is the only Client surface in the MVP.

## What's in scope

- A Thread per conversation, persisted in tier 2.
- A Run per user message, persisted in tier 2, executed by the Worker as one or more Turns.
- Run Events streamed Worker → Core → Web Client (text deltas, status, completion, errors).
- Tool Protocol carrying both ordinary tool calls and Proposals (Tool Request → user decision → Tool Result).
- A Proposal review surface inside the Web Client; approve-then-apply per [ADR-0004](./0004-three-tier-storage-authority.md).
- Tier-2 persistence for Threads, Runs, Proposals, and Accepted Entities the slice creates.

## What's out of scope

- **No Vault watcher.** External-editor capture is deferred; Core only sees Vault writes it authored.
- **No Capture Client.** No CLI, no share-sheet, no ingest-only flows.
- **No external-editor capture path.** Vault writes that originate from outside Inkstone are deferred to a later slice.
- **No automations / scheduled Runs.** Every Run is started by a user message.
- **No retrieval-augmented chat.** Reading existing notes is in scope only insofar as the Worker uses tools to do it during a Run; there is no separate "ask my notes" slice.

## Why chat-driven (not capture-driven)

A capture-driven first slice — user types into a Vault file → watcher → Ingestion → background Run → Proposal — would require the file watcher, Snapshot pipeline trigger from external events, and a quiet-time scheduler before any user-facing surface works. That's months of plumbing before the first real interaction.

Chat-driven inverts the priority: a user message is the trigger; the Worker, Tool Protocol, Run Event stream, and Proposal flow are exercised end-to-end on every Run. Capture (e.g. "met Alice about X, schedule a meeting") is still supported — the user types it into the chat, the Workflow recognises it as an interstitial entry, and the same Proposal mechanism creates the Person and Todo. The user-facing flow from CONTEXT.md's example dialogue is preserved; only the trigger differs.

## Why Web Client only

The mock on the `ui-mock` branch is a Web Client design. Building a TUI or Capture Client first would force a second Client surface to ship before the one we have UX for is real. The MVP commits to the Web Client and defers other surfaces.

## Considered and rejected

- **Capture-driven slice (Vault file → watcher → Run → Proposal).** Real product target, but pushes the first user-visible interaction behind the watcher and Ingestion pipeline. Deferred to a later slice; the Snapshot/Ingestion principle from [ADR-0005](./0005-snapshot-and-hash-ingestion.md) still applies when Core authors its own writes.
- **Apply-then-notify with undo (mock's default behavior).** The `ui-mock` branch shows most edits applied automatically with one gated approval. Rejected: contradicts [ADR-0004](./0004-three-tier-storage-authority.md), which makes Proposal-gated Entity creation the rule that prevents tier 3 from silently driving tier 2. A reliable undo for linked Entities is harder than the affordance suggests, and a hybrid policy adds a "which writes are gated" decision the MVP doesn't need.
- **Retrieval-augmented chat as the first slice.** Exercises fewer tier-2 concerns and skips the Proposal flow, which is the architecturally distinctive piece worth proving early.

## Related

- [ADR-0002](./0002-clients-talk-only-to-core.md) — Web Client talks only to Core.
- [ADR-0004](./0004-three-tier-storage-authority.md) — Proposal gating for tier-2 Entity changes.
- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — both channels are exercised in this slice.
