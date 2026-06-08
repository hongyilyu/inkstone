# Worker transport is a code-level seam: a `WorkerPort` the run loop depends on

Core's per-Run streaming loop talks to the Worker process through a **`WorkerPort`** — a small in-process interface with three operations the loop needs: pull the next `WorkerStdout` frame, send a `ToolResult` back, and shut the Worker down. The loop (`run_loop`) is **generic over the port** and owns all the run-driving logic (the ADR-0022 gate critical section, tool dispatch + allowlist, parking, terminal-state selection, hub teardown). Two adapters satisfy the port: a production **`ChildWorker`** (the sole caller of `Command::spawn`, owning NDJSON framing, manifest write, and `child.wait`) and a test-only **`ScriptedWorker`** (replays a fixed list of frames, records what the loop sent back). This replaces the previous arrangement where the only substitution point was the `INKSTONE_WORKER_CMD` env var, which forced every test of the loop's logic to spawn a real OS process.

## What this means concretely

- **`crates/core/src/worker.rs` becomes a `worker/` module**: `port` (the `WorkerPort` interface), `run` (the generic loop + tool dispatch + parking + terminal handling), `child` (the `ChildWorker` adapter), `mod` (the public `spawn`/`resume` entry points + two manifest builders). The `ScriptedWorker` lives under `#[cfg(test)]`.
- **The loop returns a typed `Exit`** (`Done` / `Disconnected` / `Errored` / `Parked`) instead of threading three local booleans, so the terminal-state decision is a value a test can assert directly.
- **`run_worker` / `run_resume_worker` are deleted.** Their only real difference was the manifest, so fresh-vs-resume collapses to two manifest builders; both hand the manifest to `ChildWorker` and call the shared `run_loop`.
- **The loop's logic is unit-testable in-process** against a `:memory:` SQLite pool and a `ScriptedWorker` — no `tsx`, no child process, no timing races. Every branch (text delta, tool round-trip, park, worker error, EOF-without-`done`) is reachable from a scripted frame sequence.
- **Nothing on the wire changes.** `WorkerStdout`, `ToolResult`, and `WorkerManifest` (ADR-0009 hand-mirrored types) are reused verbatim; the port speaks those existing types, so there is no mapping layer.

## Why a code-level seam (the env var is not enough)

`INKSTONE_WORKER_CMD` is a *process-level* seam: it swaps which executable Core launches. It is the right tool for real-process integration tests (and stays — see below), but it cannot make the loop's decision logic — terminal selection, the park branch, the exactly-once gate interleaving — reachable without spawning an OS process and racing its stdout. Those are the bug-prone parts and today they have zero in-process coverage. A code-level port lets a test feed the loop a scripted frame sequence and assert on tier-2 rows in milliseconds.

## Why generic, not runtime dependency injection

The loop is generic (`run_loop<P: WorkerPort>`), so the adapter is chosen at the call site, known at compile time: `spawn`/`resume` construct a `ChildWorker`; unit tests construct a `ScriptedWorker` and call `run_loop` directly. There is **no runtime selection** — no `Arc<dyn>` worker factory carried in app state, no "run Inkstone with a fake Worker" mode. We considered that (it would enable a no-LLM dev mode) and rejected it: no such mode is wanted, test substitution is served by the env-var fixture (integration) and the scripted port (unit), and generic dispatch is zero-cost (monomorphized, no `dyn`, no `async-trait`, no allocation on the per-delta hot path). If a runtime no-LLM mode is ever wanted, a `dyn`-safe factory can be added behind this same port without re-cutting the seam.

## What stays concrete (deliberately not ported)

Only the Worker process — the one genuinely non-substitutable, remote-but-owned collaborator — goes behind a port. The DB pool, the per-run hub, the exactly-once gate, and `tools::execute` stay as plain arguments to `run_loop`:

- The DB is **local-substitutable** — `:memory:` SQLite is already the test stand-in, so a `trait Db` would be a single-adapter seam (one production impl, no distinct test impl): indirection without leverage.
- The hub, gate, and tool registry are **in-process** — there is nothing across a boundary to substitute.

A reviewer who proposes "also port the DB for symmetry" should be answered: the `:memory:` pool already *is* the substitute. One port, for the one collaborator that needs it.

## How this refines earlier ADRs

- **[ADR-0013](./0013-worker-process-lifecycle-and-transport.md):** unchanged in substance — still per-Run, ephemeral, subprocess stdio with framed JSON, Core owning the lifecycle. This ADR pins *how that transport is expressed in Core's code*: behind `WorkerPort`, with `ChildWorker` as the sole `Command::spawn` site. The three Worker exits ADR-0013/0025 name (clean `done`, stdout-EOF-without-`done`, park) become the `Exit` enum's variants.
- **[ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md):** the exactly-once critical section (lock gate → persist delta → publish to hub → unlock) stays **inside** `run_loop`, not behind the port. The seam is below the gate; an adapter cannot observe or violate it. This ADR does not touch hub ownership — it makes the gate's interleaving in-process testable for the first time.
- **[ADR-0025](./0025-proposal-park-and-resume.md):** the park path (break the read loop on the first proposal `tool_request`, persist + park, tear the Worker down) and the resume reconstruction are unchanged. Park remains the third Worker exit; it is now `Exit::Parked`. Resume's pre-spawn work and the self-guarded `parked → running` flip stay in `resume`, outside the loop, untouched.

## Considered and rejected

- **Keep the process-only `INKSTONE_WORKER_CMD` seam, add no code seam.** Rejected: leaves the loop's logic reachable only by spawning a real process — the status quo this ADR exists to fix.
- **Runtime worker factory (`Arc<dyn>` in app state), app-wide fake-Worker mode.** Rejected: no no-LLM runtime mode is wanted; test substitution is covered by the env-var fixture + the scripted port; generic dispatch is cheaper and simpler. Revisit only if a runtime mode is actually needed.
- **A "future-proof" port (lifecycle hooks/observers, alternative socket/remote transports, concurrent multi-tool support).** Rejected as speculative (YAGNI). The port's shape does not preclude any of them, but none is built now.
- **Port the DB / hub behind their own traits.** Rejected: single-adapter seams — `:memory:` SQLite and in-process channels are already the substitutes. Indirection without leverage.

## Related

- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — Worker lifecycle + stdio transport; this ADR pins how Core expresses that transport in code.
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) — the exactly-once gate this seam leaves inside the loop.
- [ADR-0025](./0025-proposal-park-and-resume.md) — park is `Exit::Parked`; resume orchestration stays outside the loop.
- [ADR-0009](./0009-protocol-strategy.md) — the hand-mirrored wire types (`WorkerStdout`, `ToolResult`, `WorkerManifest`) the port speaks unchanged.
