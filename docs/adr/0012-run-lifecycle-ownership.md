# Run lifecycle: Core owns durable state, Worker owns in-flight Turn state

A Run is durable in Core. A Turn-in-progress is volatile in the Worker. Core persists Run state at Turn boundaries — Run created, Turn N started, Turn N completed, Run completed / errored / cancelled. The Worker holds the LLM call and the in-flight assistant text in memory only; if the Worker dies mid-Turn, that Turn is gone and the Run becomes `errored`. Inkstone does not attempt to resume a Run mid-Turn.

## Why this split

The Run is a primary user-facing artifact: it appears in history, can be reopened, cancelled, retried. That requires durability, multi-Client visibility, and a coherent state machine — all things Core is positioned to own. ADR-0002 already forbids Clients from reaching the Worker, so the Worker cannot be the source of truth for any Run state a Client needs to see.

A Turn-in-progress is the opposite. It's a partially produced LLM response and possibly a pending tool call, both of which are inherently in-flight. Persisting them mid-stream costs complexity (when exactly is partial assistant text "the truth"?) and resuming them after a crash means either replaying the prefix non-deterministically, recording the partial as a continuation, or restarting the Turn — none of which the MVP needs to take a position on.

Owning durable Run state in Core also gives the Run history surface in the Web Client a real source. Without it, "recent Runs" becomes either a Worker-side concept the Web Client cannot legally reach, or a re-derivation from Run Events Core happens to have logged.

## What Core persists at each boundary

- **Run created.** Thread, Workflow, prompt, status `pending`.
- **Run started.** Status `running`, started_at.
- **Turn N started / completed.** Indexed within the Run; carries the user-visible result of that Turn (final assistant text, tool calls issued, tool results received).
- **Run completed / errored / cancelled.** Final status, ended_at, error message if any.

Run Events stream Worker → Core throughout; Core forwards them to subscribed Clients and persists them as needed for history. Whether every `text_delta` is durably stored or only the final assembled text is a tier-2-schema decision deferred to the schema ADR.

## What the Worker keeps in memory

- The current Turn's prompt, partial assistant text, and pending tool call bookkeeping.
- Conversation context being assembled for the next LLM call.
- Tool result waitlists.

None of this survives a Worker restart. None of it is durable.

## Crash and cancellation behavior

- **Worker dies mid-Turn.** Core notices the connection drop, marks any Run currently `running` on that Worker as `errored` with reason `worker_disconnected`. The user sees the Run in history with an error and can retry by sending the same prompt again — which creates a new Run.
- **Core dies.** Worker's in-memory Run is moot. On Core restart, any Run still in `running` state is force-transitioned to `errored` with reason `core_restarted`. Same retry path.
- **User cancels.** Core marks the Run `cancelled` immediately. Core signals the Worker to abort; if the Worker has already crashed or is unreachable, the cancellation still takes effect from the user's point of view. Worker discards in-flight Turn state on receiving the abort.

The principle: **the user-visible Run state is whatever Core says.** Worker reports flow into Core, but Core is the authority a Client trusts.

## What this rules out for the MVP

- **Mid-Turn resumption.** No replaying or stitching partial Turns. A crashed Turn is a dead Run.
- **Multi-Worker Run sharing.** A Run is bound to the Worker that started it for its lifetime. Reassigning a Run to a different Worker is not a thing.
- **Worker-side Run history.** The Worker has no knowledge of past Runs. Each Run is dispatched fresh.

These can be revisited; none is foundational.

## Considered and rejected

- **Worker owns Run state.** Simpler single-component lifecycle, but Run history is then either invisible to Clients (violating ADR-0002 since they cannot reach the Worker) or re-derived ad hoc. The mock's Run history sidebar requires durable Runs in Core.
- **Core owns Run state including mid-Turn.** Persist every `text_delta` and partial tool call so that a crashed Turn can be resumed. Real value at scale, but commits to a non-trivial resumption strategy (replay, splice, or restart) before the slice has any reason to prefer one.

## Related

- [ADR-0002](./0002-clients-talk-only-to-core.md) — Clients reach the Worker only through Core, which is why Run state has to be in Core to be visible.
- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — Run Events are observational; Core persists what it needs from them.
- [ADR-0010](./0010-mvp-slice-chat-driven-web-client.md) — the slice this lifecycle serves.
- [ADR-0025](./0025-proposal-park-and-resume.md) — adds `parked` as a durable, non-terminal Run state; parked Runs survive a Core restart instead of being force-errored.
- [ADR-0028](./0028-run-status-materialized-transitions.md) — adds an `errored → running` retry edge (`run/retry`): a dead Run is no longer strictly terminal — the user can re-drive it in place (re-driving the user prompt fresh, not replaying the crashed Turn), amending the "a crashed Turn is a dead Run" framing here.
