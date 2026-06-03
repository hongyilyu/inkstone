# Proposal application policy: every Workspace mutation is a Proposal; auto-approve is a Core-side policy on the same flow

Every Worker-initiated Workspace mutation is submitted as a **Proposal** through the Tool Protocol. Core decides per Proposal whether to apply it immediately (auto-approve) or to surface it for explicit user decision (manual approve). The decision is invisible to the Worker — the Tool Result it eventually receives carries `{decision: "accept" | "reject" | "edit", …}` regardless of who made it. There is one write path: Proposal in, atomic application out.

The set of auto-approve rules is **not pinned in this ADR**. Each Workflow declares which of its operations may auto-approve as part of the Workflow manifest. The mechanism exists; the policy table is data, not architecture.

## What counts as a "Workspace mutation"

In scope (Proposal-gated):

- Create / update / delete an Accepted Entity (Person, Todo, Project, …).
- Update Thread metadata (title, tags) when the Worker initiates it.

Out of scope (not Proposals):

- **Reads** — entity queries, search. Tool Protocol calls without Proposal semantics.
- **Run-internal bookkeeping** — Run Events Core persists, Run/Turn state transitions, Tool Request/Result records. These are Core's persistence of in-flight Run state, not Worker-initiated changes to the Workspace.
- **Vault export writes** — the Vault is a tier-3 derived export (per [ADR-0004](./0004-three-tier-storage-authority.md), [ADR-0005](./0005-snapshot-and-hash-ingestion.md)); regenerating exported documents is derived rendering, not a user-gated mutation.

## Why one write path

The naive alternative is "Worker calls `write_file` directly when no approval is needed; submits a Proposal otherwise." That splits the write path: two code paths in Core, two audit trails, two ways the Workspace can change. Each tool that wants the fast path has to decide for itself when to use it; the policy gets scattered across the tool set.

Folding everything into the Proposal flow means:

- **Single audit log.** Every mutation has a Proposal record in tier 2 with originator, decision (auto vs manual), timestamp, and applied-state.
- **Single point of policy.** `Core::should_auto_approve(proposal) -> bool` is the only function that decides. Changing the policy is editing one function (or its data).
- **Reversal is uniform.** Auto-approved Proposals are still Proposal records; reviewing or undoing one looks identical to a manually approved one.
- **The Worker stays oblivious.** A Workflow author writes "submit a Proposal" without thinking about whether the user will see it. That's the point of [ADR-0003](./0003-worker-via-tool-protocol.md) — Tool Protocol is the chokepoint Core controls.

## How auto-approve works

When the Worker submits a Tool Request that is shaped as a Proposal, Core:

1. Persists the Proposal in tier 2 (status `pending`).
2. Consults the auto-approve policy for this Workflow + operation.
3. If the policy says auto-approve: Core applies the Proposal atomically and resolves the Tool Request immediately with `{decision: "accept", auto: true}`. The Web Client receives a `proposal/changed` Notification reflecting the applied state and a `entity/changed` Notification for whatever was mutated, but no `proposal/pending` (the user does not need to act).
4. If the policy says manual: Core emits a `proposal/pending` Notification to subscribed Clients. The Worker is parked (per [ADR-0013](./0013-worker-process-lifecycle-and-transport.md)). When the user calls `proposal/decide`, Core applies (or rejects/edits) and resumes the Run with the decision in the Tool Result.

The Worker cannot tell the two paths apart from inside the Workflow code. The Tool Result carries `auto: true` for transparency in logs and the activity feed, but the Run continues either way.

## Why the auto-approve table belongs to the Workflow, not this ADR

The set of auto-approveable operations is a property of *each Workflow's* design — what does this Workflow need to do, and which of those things has the user sufficiently pre-authorized by choosing this Workflow?

- The "scan recent captures and propose structure" Workflow probably auto-approves nothing — its whole job is producing Proposals for the user to review.
- A future "summarize this week's notes into a Friday digest" Workflow might auto-approve writing the summary to a fixed location, because the user opted into the Workflow specifically for that output.
- A future "fix typos in this note" Workflow might auto-approve text-only edits but require manual approval for structural changes.

Pinning a global table in this ADR forces every Workflow into the same shape. Letting the Workflow manifest carry its own auto-approve list keeps the policy where the context lives.

The Workflow manifest format is decided in [ADR-0018](./0018-workflow-and-tools-definition.md). What this ADR commits to is: **wherever the table lives, the mechanism Core uses to consult it is the same single-policy-function described above.**

## What slice 1 does

Slice 1 ships the mechanism with an empty policy table. Every Proposal in slice 1 goes through manual approve. No operation auto-approves. The Web Client always sees `proposal/pending` for any Workspace mutation; the user always decides.

This is intentional: the chat-driven slice's whole shape is "user captures → Worker proposes structure → user approves." Auto-approving any of those defeats the slice's purpose. The architecture is forward-compatible; the data is empty.

## Considered and rejected

- **Auto-approve = bypass Proposal entirely.** Worker calls `write_file` directly when policy allows; submits a Proposal otherwise. Rejected: two write paths, scattered policy, audit log split. The single-point-of-policy gain is foundational, not optional.
- **Auto-approve table pinned in Core.** Hard-codes a global "these ops are safe" list. Rejected: doesn't account for context (different Workflows have different appropriate auto-approve sets) and forces a taxonomy decision before any Workflow runs.
- **Per-user settings for auto-approve.** Useful eventually ("I always auto-approve Todo creation"), but presupposes a tool taxonomy and a user-settings surface neither of which exists in MVP.
- **Reading (B) — auto-approve as a separate code path that skips Proposal records.** Faster but loses the audit log uniformity. Rejected for the same single-write-path reason as the bypass alternative.

## Related

- [ADR-0003](./0003-worker-via-tool-protocol.md) — Tool Protocol is Core's chokepoint; this ADR rides on that.
- [ADR-0004](./0004-three-tier-storage-authority.md) — Proposal-gated Entity creation; this ADR extends to all Workspace mutations.
- [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md) — approve-then-apply confirmed for slice 1.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — Worker is parked while a manual Proposal awaits decision; auto-approve resolves immediately and the Run continues without parking.
- [ADR-0014](./0014-client-core-wire-protocol.md) — `proposal/pending` and `proposal/changed` are the Notifications surfaced by this flow.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — Workflow manifest format that carries each Workflow's auto-approve declarations.
