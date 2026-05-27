# Two-component split: Core (Rust) and Worker (TypeScript)

Inkstone is split into two components across a process and language boundary: **Core** in Rust and **Worker** in TypeScript. Core owns durable Workspace state, the SQLite database, the Vault, and controlled integrations. Worker owns the agent loop and LLM-provider interaction.

## Why

- **Language fit on each side.** Rust suits durable local state, reliable file IO, indexing, background processing, and long-lived daemon behavior. TypeScript suits agent-loop iteration speed and integration with pi-sdk and the LLM-provider SDK ecosystem, which are first-class in TS today and not in Rust.
- **Project learning goal.** Inkstone is also a vehicle for building a real system in both languages. Collapsing to a single language would defeat that goal; the design should resist drifting toward one stack purely for short-term convenience.
- **The cost of the boundary is the protocol.** Paying it once is cheaper than fighting either ecosystem on the wrong side.

## Considered and rejected

- **All Rust.** Forfeits the agent-side velocity and SDK reuse that justify TypeScript at this stage.
- **All TypeScript.** Forfeits the durability and background-processing strengths Rust gives Core, and defeats the learning goal.
- **Single language with FFI / native module.** Replaces a clean process boundary with a tight in-process coupling and the deployment pain of native modules — for benefits the process boundary already provides.

## Consequences

- A protocol between Core and Worker is mandatory; see [ADR-0006](./0006-run-events-vs-tool-protocol.md) for its shape and [ADR-0008](./0008-repo-shape-and-protocol-strategy.md) for how it is shared across languages.
- Tools and integrations belong in Core by default; LLM-provider logic belongs in the Worker by default.
- Worker has no direct access to the SQLite database or the Vault; see [ADR-0003](./0003-worker-via-tool-protocol.md).
