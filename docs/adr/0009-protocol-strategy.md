# Protocol strategy: manually mirrored types + contract tests

For the MVP, the Worker ↔ Core protocol types are defined manually on both sides — Rust types in `crates/core` and TypeScript types in `packages/protocol`. Consistency between the two is enforced by **contract tests** that exercise serialization, deserialization, and round-trips across the language boundary, living in `bridges/`.

## Why not schema-first generation

Schema-first approaches (protobuf, JSON Schema + codegen, OpenAPI, Avro) and Rust-first generation (ts-rs, specta, similar) are real alternatives. They guarantee structural consistency by construction, which is genuinely valuable.

We are declining them for the MVP because:

- **The protocol surface is small and changing.** Hand-writing the types twice is cheap when the surface is small. The cost grows with surface area, and we will revisit when the cost gets meaningful.
- **Codegen toolchains add real complexity.** Build steps, watch modes, IDE integration, generated-file conventions, debugging through generated code — all of it pays back at scale, but is overhead at the start.
- **Manual mirroring keeps both sides idiomatic.** A `Result<T, E>` in Rust and a `Result<T, E>`-shaped sum type in TypeScript can each look natural in their own language. Generated types tend to look generated on at least one side.

The contract tests are the real quality bar — they catch the drift that manual mirroring is most likely to produce.

## When to revisit

This decision is explicitly MVP-only. Triggers to revisit:

- The protocol surface grows beyond what hand-mirroring can keep coherent.
- Drift incidents become frequent enough that contract tests are catching them after merge rather than before.
- A new component (Client SDK in another language, native integration) needs a third copy.

At any of those, switch to schema-first or Rust-first generation. The contract tests remain useful even after switching.

## Considered and rejected

- **Schema-first (protobuf / JSON Schema + codegen).** Strongest consistency guarantee. Rejected for MVP on toolchain-complexity grounds; reasonable to adopt later.
- **Rust-first generation (ts-rs / specta).** Lighter toolchain than full schema-first. Rejected because Rust-driven types tend to feel non-idiomatic on the TypeScript side, and because the surface is small enough that the gain is marginal today.
- **TypeScript-first generation.** Less mature on the Rust side and would put Worker concerns ahead of Core concerns, which inverts the architectural primacy.

## Related

- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — what the protocol carries.
- [ADR-0008](./0008-monorepo-shape.md) — where the protocol packages live.
