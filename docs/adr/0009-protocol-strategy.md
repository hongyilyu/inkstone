# Protocol strategy: manually mirrored types + contract tests

For the MVP, the Worker ↔ Core protocol types are defined manually on both sides — Rust types in `crates/core` and TypeScript types in `packages/protocol`. Consistency between the two is enforced by **contract tests** that exercise serialization, deserialization, and round-trips across the language boundary, living in `tests/contract`.

## Why not schema-first generation

Schema-first approaches (protobuf, JSON Schema + codegen, OpenAPI, Avro) and Rust-first generation (ts-rs, specta, similar) are real alternatives. They guarantee structural consistency by construction, which is genuinely valuable.

We are declining them for the MVP because:

- **The protocol surface is small and changing.** Hand-writing the types twice is cheap when the surface is small. The cost grows with surface area, and we will revisit when the cost gets meaningful.
- **Codegen toolchains add real complexity.** Build steps, watch modes, IDE integration, generated-file conventions, debugging through generated code — all of it pays back at scale, but is overhead at the start.
- **Manual mirroring keeps both sides idiomatic.** A `Result<T, E>` in Rust and a `Result<T, E>`-shaped sum type in TypeScript can each look natural in their own language. Generated types tend to look generated on at least one side.

The contract tests are the real quality bar — they catch the drift that manual mirroring is most likely to produce.

## As-built: the schema-parity gate (2026-06)

The contract-test leg this ADR called for now exists in `tests/contract`, and it covers a second, larger surface beyond the Worker ↔ Core protocol types this ADR was written about: the **agent-proposable Workspace mutation payloads**. Core single-sources each of the 13 proposable kinds' payload shape from one `PayloadSpec` (`crates/core/src/field_spec.rs`), which emits an inline Draft-07 fragment; the Web side hand-mirrors each as an Effect Schema. The gate dumps the Rust schema per kind to a committed fixture and asserts the Effect Schema, run through `JSONSchema.make` and normalized to a common dialect, deep-equals it. Note the wire `payload` itself stays `S.Unknown` in `packages/protocol` — the typed Effect Schemas live only in the test package, so this is a contract *test*, not a wire-type change.

Two boundaries are deliberate and worth recording, because they bound what "the schemas agree" means:

- **It compares the advertised schema, not the validator, and not the envelope.** Where Core deliberately advertises a looser schema than it validates (a bare-string `entity_id` it nonetheless UUID-checks; plain-string `aliases`/`tags`/`remove_person_ids` elements it requires non-empty), the mirror follows the *schema*. Cross-field invariants (status↔timestamp, the recurrence couplings, exactly-one entity_ref, `ended_at >= occurred_at`) are hand-written hooks in `crates/core/src/entities.rs`, not in the schema layer, so the gate does not see them. The `{mutation_kind, payload, rationale}` envelope and the top-level `oneOf` framing are Core-owned and not mirrored.
- **It is a structural-drift catcher** — field presence, optionality, type, and enum domain across the seam — **not a full-contract catcher.** A field added on one side but forgotten on the other turns CI red; a semantic divergence inside an already-present field does not.

This is the implementation of this ADR's discipline, at the location [ADR-0008](./0008-monorepo-shape.md)/[ADR-0019](./0019-test-harness-architecture.md) name, in [ADR-0018](./0018-workflow-and-tools-definition.md)'s inline-Draft-07 dialect — not a new decision. The package's own `README.md` carries the same in/out-of-scope boundary for contributors.

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
