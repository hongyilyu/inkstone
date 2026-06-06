# Proposals park the Run; resume via Worker tear-down + `agentLoopContinue`

A **Proposal** is a Tool Request whose Tool Result is a human **Decision**. When a Workflow's tool call needs manual approval, Core persists the Proposal, sets the Run to `parked` (recording the waitpoint in `runs.awaiting_tool_call_id`), emits a `proposal/pending` Notification, and **tears the Worker down**. On `proposal/decide`, Core applies the change atomically to tier 2, **reconstructs the Run's transcript** from tier 2, spawns a fresh Worker, and resumes the agent loop via `pi-agent-core`'s `runAgentLoopContinue` — seeding a transcript whose last message is the awaited tool's result, now carrying the Decision. The model continues from there.

## Why tear-down + resume (not keep-alive)

A parked Run can wait minutes to weeks, and a local-first user quits and relaunches the app while a Proposal sits pending. Two facts force the design:

- Holding a Worker (and its LLM-provider connection) idle for that span is dead weight ([ADR-0013](./0013-worker-process-lifecycle-and-transport.md)).
- The wait must survive a **Core restart** — and only a durable persist-then-resume does. A keep-alive, in-process await (the ACP / pi-TUI / openclaw model, where `beforeToolCall` blocks while a long-lived process holds the loop) cannot, because its waitpoint is in memory.

Since the durable path is required regardless, keep-alive would be a pure latency optimization on top of it — not worth a second mechanism for the MVP. `pi-agent-core` makes the durable path first-class: `runAgentLoopContinue` continues a transcript whose final message is a `toolResult` **without re-executing** the prior tool calls (verified in `packages/agent/src/agent-loop.ts`). Resume is an SDK-blessed operation, not a workaround.

## Mechanics this pins

- **One Tool Request = one Proposal = one entity = one Decision.** No batching, no partial approval. The proposal tool (`propose_entity`) is `executionMode: "sequential"`.
- **Decision vocabulary: accept / reject / edit.** *Reject* resolves as a **normal** Tool Result (not an error) so the model continues conversationally rather than retrying a "failure." *Edit* applies a Core-validated `edited_payload` in one step.
- **Resume transcript** is reconstructed from `run_steps` + `tool_calls` + message text into a **typed-block manifest**: assistant messages carry `tool_call` blocks; `tool_result` messages carry results. **Every** `tool_call` in the parked turn is paired with a result — its persisted result, the Decision for the parked call, or a synthesized "not executed" result for an unexecuted sibling — so the transcript is provider-valid (a `toolResult` is rejected by providers unless its `toolCall` precedes it).
- **The parked Run is surfaced via Run status + the `proposal/*` channel.** The Run Event stream stops **without** a `done`; `run/subscribe` reports `parked`. Resume creates a fresh per-run hub. The wire `RunEvent` enum stays frozen at `text_delta`/`done`/`error` — the Proposal lifecycle rides `proposal/pending` and `proposal/changed`, not a new Run Event.
- **Auto-approve is a Core seam** (`should_auto_approve`) on the same path; it returns false for now (every Proposal is manual), per [ADR-0016](./0016-proposal-application-policy.md). The Worker is oblivious to auto vs manual either way.

## How this refines earlier ADRs

- **[ADR-0012](./0012-run-lifecycle-ownership.md):** adds `parked` as a durable, non-terminal state distinct from `errored`. A Worker tear-down **on park** is routine (between-Turn), not a crash; a parked Run is **not** force-errored on Core restart (the restart sweep targets `running`/`pending` only) and stays decidable.
- **[ADR-0013](./0013-worker-process-lifecycle-and-transport.md):** makes the "park then tear down, respawn on resume" path concrete and names `runAgentLoopContinue` as the resume entry point. Park is a third Worker exit, distinct from clean `done` and from stdout-EOF-without-`done` (which remains `worker_disconnected`).
- **[ADR-0016](./0016-proposal-application-policy.md):** the manual-approve Decision is delivered to the model **as the awaited tool's result on resume** (not in the original process). The single atomic apply path is shared by auto and manual.
- **[ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md):** `run/subscribe` gains a `parked` branch — snapshot + status, no `done`, no tail — so a refreshed Client does not see a false terminal. Resume re-creates the hub like a new stream segment.

## Considered and rejected

- **Keep the Worker alive and block the tool's `execute()` until the Decision** (in-process await; how pi's TUI/RPC host and openclaw's ACP Gateway do it). Rejected: their processes are long-lived daemons, so an in-memory waitpoint is fine; Inkstone's Workers are per-Run and ephemeral, and the wait must survive a Core restart, which only the durable path achieves. See *Why* above.
- **Adopt ACP (`@agentclientprotocol/sdk`) for the Client surface.** ACP earns its cost when hosting **foreign/heterogeneous** agents (openclaw spawns Codex et al. over ACP). Inkstone has one engine (the pi Worker) and one Client (its embedded SPA), so a bespoke `proposal/*` that **mirrors ACP's permission-request shape** suffices, honoring [ADR-0014](./0014-client-core-wire-protocol.md)'s "not literal ACP." Revisit if Inkstone ever hosts an external agent as a Workflow engine.
- **Batch / per-entity Proposals.** Rejected: one-at-a-time keeps a single pending Proposal per Run, sidesteps multi-park, and matches "applied atomically."

## Related

- [ADR-0003](./0003-worker-via-tool-protocol.md) — Tool Protocol is Core's chokepoint; the Proposal rides it.
- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — Proposals await; Run Events do not. The Decision is a Tool Result, not a Run Event.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — `propose_entity` is a Core-registered tool; the manifest gains typed message blocks + a `mode: fresh|resume` field here.
