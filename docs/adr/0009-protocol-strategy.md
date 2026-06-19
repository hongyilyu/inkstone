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

The contract-test leg this ADR called for now exists in `tests/contract`, and it covers a second, larger surface beyond the Worker ↔ Core protocol types this ADR was written about: the **agent-proposable Workspace mutation payloads**. Core single-sources each of the 13 proposable kinds' payload shape from one `PayloadSpec` (`crates/core/src/field_spec.rs`), which emits an inline Draft-07 fragment; the Web side hand-mirrors each as an Effect Schema. The gate dumps the Rust schema per kind to a committed fixture and asserts the Effect Schema, run through `JSONSchema.make` and normalized to a common dialect, deep-equals it. The wire `payload` itself stays `S.Unknown` in `packages/protocol` — this is a contract *test*, not a wire-type change.

**Update (2026-06): the 13 schemas live in `packages/protocol`, not the test package.** The hand-mirrored Effect Schemas were promoted from `tests/contract/src/schemas.ts` into `packages/protocol/src/payloads.ts` (re-exported from the package barrel), and `tests/contract` now imports the registry from `@inkstone/protocol`. The move is what makes the parity gate guard the *shipped* schema rather than a test-only mirror: the same `schemas` object the Web's per-Entity-Type codec (`apps/web/src/lib/entityCodec.ts`) decodes/encodes against is the one the gate deep-equals with the Rust fixtures. The wire boundary is unchanged — `EntityMutateParams.payload` / `EntityRow.data` stay `S.Unknown`; the typed schemas are a Web-side validation concern layered over the opaque wire, not a tightening of the protocol type. The 13-kind `schemas` registry the parity gate iterates is unchanged in membership; `completeness.test.ts` still locks it to exactly the 13 committed fixtures.

`packages/protocol` additionally holds three **ungated** bookmark payload schemas (`createBookmark` / `updateBookmark` / `deleteBookmark`) the Web codec consumes for the `bookmark` editor. These are deliberately **outside** the 13-kind parity registry and have no Rust fixture, because `bookmark` is a user-CRUD-only kind the agent never proposes (ADR-0036) — Core validates it but does not advertise it via `PayloadSpec`, so there is no Rust schema to reconcile against. The trade-off is explicit: these three schemas can drift from Core's `validate_bookmark` without the gate catching it, the same structural-drift exposure the gate otherwise closes. They earn their place by giving the Web codec one uniform schema-backed shape across all five Library editors; if `bookmark` ever becomes agent-proposable, it gains a `PayloadSpec` + fixture and joins the gated registry.

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

## As-built: the non-payload wire-message parity gate (2026-06)

The original contract-test leg this ADR called for covered only the agent-proposable mutation *payloads* (the `PayloadSpec`-derived schemas above). The Worker↔Core protocol types this ADR was actually written about — the ~35 plain serde wire structs hand-mirrored in `crates/core/src/protocol.rs` and `packages/protocol/src/index.ts` — were still verified only **per-side**: each language decoded a literal it hand-authored, so a shared author misconception (an omitted field, an optional spelled as required) passed *both* suites green. That hole is now closed; this finishes the leg, it is not a new decision.

**One committed fixture is the shared artifact both sides must satisfy, per wire message.** Unlike the payload gate (schema-vs-schema: it diffs `PayloadSpec.json_schema()` against `JSONSchema.make(EffectSchema)`), the non-payload gate is **instance-based** — the fixture is a real *serialized value*, not a schema. This was deliberate: the protocol structs use `#[serde(skip_serializing_if)]` pervasively, and a type-derived schema (schemars) would emit a nullable `["T","null"]` for a field the wire *omits* — a lie that would hide the exact null-vs-absent drift the gate exists to catch. Serializing a real instance through the production serde path sidesteps that: the fixture is ground-truth wire bytes.

Fixtures come from two sources, by serde direction:

- **Core-emitted** (`tests/contract/fixtures/structs/emitted/`) — for the Serialize-capable messages (results, notifications, the Worker manifest, the run-event / tool-result frames). An inline `#[test] regenerate_struct_fixtures` (in `protocol.rs mod parity_fixtures`, alongside the payload emitter and inline in `src/` for the same binary-only-crate reason) serializes one canonical instance per message and a sibling `emitted_fixtures_match_committed` `include_str!`-locks them, so `cargo test` itself bites on a stale fixture. CI regenerates + `git diff --exit-code`s this dir.
- **Hand-authored** (`tests/contract/fixtures/structs/authored/`) — for the Deserialize-only params (the 13 `*Params`, `WorkerStdout`). Core never serializes these in production, so the fixture is the canonical wire JSON the Web sends, written by hand; `authored_fixtures_parse` asserts each round-trips through the Rust `Deserialize` (the producer-side check). These are **never** regenerated. Auto-serializing them was rejected: params like `RunGetHistoryParams.limit` / `SettingsSetParams.{model,effort}` are `Option` without `skip_serializing_if`, so a serialized `None` emits `{"field":null}`, which the Web `S.optional` schema *rejects* — a false red against a shape Web never sends.

The TS half (`tests/contract/src/structs.test.ts`) decodes each fixture against the hand-authored Effect Schema with `onExcessProperty: "error"` (a field the Rust side emits but TS lacks reds here) and re-encodes it back to deep-equal the fixture (a field TS drops, renames, or coerces reds here). Effect's `encodeSync` omits an absent optional rather than emitting `null`, so the `skip_serializing_if` fields round-trip cleanly. A `structs.completeness.test.ts` lock pins the in-scope message set (registry ≡ committed fixtures ≡ a hand-maintained canonical list) plus a per-tagged-union variant count, so a silently dropped variant or message reds.

Boundaries worth recording (they bound what "the structs agree" means):

- **Tagged-union asymmetry is real and intended.** Rust's `WorkerStdout` (4 variants Core reads off stdout) does not mirror the TS `WorkerOutbound = RunEvent | ToolRequest` union one-for-one — the Web union is deliberately *broader* (the Worker never emits `RunEvent`'s `cancelled`/`tool_call`). The authored `WorkerStdout` fixtures decode against `WorkerOutbound` and that asymmetry is documented at the test, not "fixed."
- **One accepted blind spot (the price of instance-based).** A field that is optional on the TS side and *entirely absent* on the Rust side is invisible: Rust never emits it, so no fixture exercises it, and decode-without-it succeeds. Severity is low — a permissive phantom field Web would accept but Core never sends (dead schema, not a crash). The schema-vs-schema payload gate catches this class; the instance-based gate trades it away for serde-path ground truth.
- **Same structural-drift boundary as the payload gate.** Field presence / optionality / type / enum-domain across the seam — not cross-field invariants (those are `entities.rs` hooks), and the JSON-RPC envelope (`JsonRpcRequest`/`JsonRpcResponse`) stays out, because it has no field-for-field TS mirror to reconcile (the ui-sdk decodes a deliberately partial, divergent envelope). No wire-type change: the typed schemas remain a test-and-Web-validation concern layered over the opaque wire.

## Related

- [ADR-0006](./0006-run-events-vs-tool-protocol.md) — what the protocol carries.
- [ADR-0008](./0008-monorepo-shape.md) — where the protocol packages live.
