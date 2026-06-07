# Worker process lifecycle: per-Run, ephemeral, subprocess stdio

Each Run runs in its own Worker process. Core spawns the Worker, hands it the full context (Thread history, current Run prompt, prior Turns, Workflow definition), the Worker drives Turns until it either completes the Run or hits a boundary that requires waiting (a Tool Request whose result isn't yet available, most importantly a Proposal awaiting user decision). At those boundaries Core may tear the Worker down. When the awaited Tool Result is ready, Core spawns a fresh Worker for that same Run, replays the Run state from tier 2, and the new Worker continues from the next Turn.

Transport between Core and a Worker is **subprocess stdio with framed JSON** — Core spawns the Worker as a child process and the two communicate over stdin/stdout.

## What this means concretely

- A Workspace can have any number of in-flight Runs simultaneously. N Runs ⇒ up to N Worker processes.
- Workers are short-lived. The expected lifetime of a single Worker process is one Run (often) or one segment of a Run between durable parking points (when Proposals or other long-await Tool Requests are involved).
- Workers carry no cross-Run state. Two Runs against the same Workflow are two unrelated processes that happen to load the same prompt and tool list.
- Workers keep no durable state of their own. Anything that needs to survive a Worker tear-down is in tier 2 (per [ADR-0012](./0012-run-lifecycle-ownership.md)).

## Why per-Run

- **Concurrent Runs are the primary case, not the exception.** A user can be in two Threads at once; a future cron job can fire while a chat is ongoing. Multiplexing them inside one Worker invents an in-Worker scheduling problem (per-Run state isolation, fairness, cancellation semantics) that the OS already solves by spawning processes.
- **Workflow isolation is free.** A misbehaving Workflow cannot leak state into another Run because there is no shared Worker.
- **The Worker is the LLM-call holder.** Holding it open during a Proposal wait is dead weight — LLM SDK connections, per-Workflow context, possibly cached tool wrappers, all idle for as long as the user takes to approve. Tearing down releases everything immediately and reconstitution is cheap.

## Why ephemeral (allowed to die at Turn boundaries)

A Run can park for arbitrary wall-clock time. The most common case is a Proposal waiting for user approval; the user might take a minute or a week. Keeping a Worker alive for that span burns memory and an LLM-provider connection for no progress. The state needed to resume — Thread history, prior Turns, the Tool Result being awaited — is already in Core (per [ADR-0012](./0012-run-lifecycle-ownership.md), Core persists at Turn boundaries). Spawning a fresh Worker and feeding it that state is a strict subset of the work Core is doing anyway.

This refines [ADR-0012](./0012-run-lifecycle-ownership.md) without contradicting it: Worker death **mid-Turn** is still `errored`. Worker tear-down **between Turns** — including while parked on a Tool Result — is routine and does not error the Run. The distinction is that a between-Turn Worker has nothing in flight to lose.

## Why subprocess stdio

- **Core owns the lifecycle by construction.** The Worker is a child process; Core has the PID and exit signal. No connection-management state machine, no port allocation.
- **No auth surface.** A child of Core inherits trust from being spawned by Core. Compare: a loopback TCP/WebSocket Worker requires deciding whether localhost is enough, and what happens if a second Core instance starts.
- **Cross-platform.** stdio works the same on macOS, Linux, and Windows; Unix domain sockets do not.
- **Honors [ADR-0009](./0009-protocol-strategy.md).** Manually mirrored JSON types over a stdio framing. No codegen, no schema toolchain.
- **Per-spawn cost matters more under per-Run.** stdio is the fastest spawn option — no port bind, no handshake.

The cost is that you cannot easily attach a separately running Worker to Core for development (e.g. a hot-reload TS dev server). When that becomes painful, switch transports; the protocol is transport-independent (per [ADR-0006](./0006-run-events-vs-tool-protocol.md)).

## What this does not decide

- **Worker pool.** Whether Core keeps a small pool of warm Workers to shave off spawn latency. Pure optimisation; revisit if spawn time hurts.
- **Resumption envelope size.** How much Thread/Run context Core ships into a fresh Worker on resume. Schema-level decision; deferred to the tier-2-schema ADR.
- **Worker-side caching across spawns.** None for the MVP; anything cross-Run that would speed things up belongs in Core.
- **Backpressure on event streams.** When Core is slow to consume Run Events, what the Worker does. Policy decision deferred until it bites.

## Considered and rejected

- **One long-lived Worker per Workspace, multiplex Runs internally.** Simpler process tree, but invents an in-Worker scheduler, holds resources during Proposal waits, and gives up the OS-level isolation between Runs. Rejected.
- **Lazy long-lived Worker (spawn on first Run, kept alive forever).** Defers spawn cost only the first time, then has all the long-lived problems. Rejected.
- **Loopback TCP / WebSocket transport.** Better for development tooling (attach a debugger, hot reload), but adds port management, an auth question, and connection lifecycle handling. Premature for MVP; revisit when development friction motivates it.
- **gRPC streaming.** Strong streaming and serialization story; brings a codegen toolchain that contradicts [ADR-0009](./0009-protocol-strategy.md) for MVP.
- **Unix domain socket.** Avoids ports and has filesystem-permission auth, but the cross-platform story (especially historic Windows) is weaker than stdio for no real gain over the parent-child trust model.

## Related

- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — what the protocol carries; this ADR pins how it travels.
- [ADR-0009](./0009-protocol-strategy.md) — manual type mirroring; stdio JSON makes this concrete.
- [ADR-0012](./0012-run-lifecycle-ownership.md) — Run state owned by Core. Per-Run ephemeral Workers depend on this; this ADR refines the "Worker dies" cases.
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) — where a Worker's emitted Run Events land: a per-run hub owned by Core, not the connection that started the Run.
- [ADR-0025](./0025-proposal-park-and-resume.md) — makes the park / tear-down / respawn path concrete; `runAgentLoopContinue` is the resume entry point, and park is a third Worker exit distinct from `done` and disconnect.
