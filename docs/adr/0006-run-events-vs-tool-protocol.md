# Run Events and Tool Protocol are separate logical channels

The Worker → Core communication during a Run is modeled as two distinct logical channels: a one-way **Run Event** stream (text deltas, status, completion, errors) and a bidirectional **Tool Protocol** carrying Tool Requests and Tool Results. They have different semantics, and code on both sides treats them as separate concepts.

The wire-level transport — whether one connection multiplexes both, two separate connections are used, or some other arrangement — is not decided here.

## Why

The two channels differ on every axis that matters for protocol design, even though they ride between the same two components:

- **Directionality.** Run Events flow Worker → Core. Tool Requests are paired with Tool Results: Worker → Core → Worker.
- **Awaiting.** A Run Event is fire-and-forget for the Worker. A Tool Request blocks Run progress until the matching Tool Result arrives.
- **Consumer behavior.** Core consumes Run Events by persisting and forwarding them; it consumes Tool Requests by validating, executing, and replying.
- **Reliability needs.** Run Events are observational; losing the last `text_delta` on a cancelled Run is acceptable. Tool Requests must complete reliably or the Run cannot continue.

Mashing them into one bidirectional message bus pushes these differences into discipline — every message handler has to remember which kind of message it is dealing with and apply the right reliability and awaiting rules. Separating them logically lets each channel have the shape it needs.

## Out of scope

- Transport (WebSocket, gRPC streaming, subprocess stdio, local IPC, or other).
- Serialization (JSON, MessagePack, protobuf).
- Whether the two logical channels share a single underlying connection.
- Backpressure, flow control, and timeout policies.

These are implementation choices for a later ADR or just a code decision; they do not change the logical split.

## Related

- [ADR-0008](./0008-repo-shape-and-protocol-strategy.md) — how the protocol types are shared across Rust and TypeScript.
