# @inkstone/contract — wire-schema parity gate

A CI gate that proves the **Rust** and **TypeScript** definitions of the wire
protocol agree. It has two legs:

1. **Payload parity** (schema-vs-schema) — the wire `payload` for the 15
   agent-proposable Workspace mutations, per kind.
2. **Non-payload parity** (instance-based) — the ~35 plain serde wire messages
   (params, results, notifications, the Worker manifest, the run-event /
   tool-result frames) hand-mirrored in `crates/core/src/protocol.rs` and
   `packages/protocol/src/index.ts`. See "Non-payload structs" below.

## Payload parity (the 15 proposable kinds)

- **Rust** (`crates/core`) is the schema-of-record. An inline test
  (`regenerate_schema_fixtures` in `src/tools/propose_workspace_mutation.rs`)
  dumps each kind's `ProposableMutation::payload_spec().json_schema()` — the same
  expression that drives the agent tool descriptor — to `fixtures/<wire_kind>.json`.
- **TypeScript** hand-authors one Effect Schema per kind in
  `packages/protocol/src/payloads.ts` (the `schemas` registry, re-exported from
  the package barrel and consumed by the Web codec at runtime). `parity.test.ts`
  runs each through `JSONSchema.make`, runs both it and the Rust fixture through
  `normalize.ts`, and asserts deep-equality. `completeness.test.ts` locks the
  registry to the 15 committed fixtures.

This implements ADR-0009's already-decided "manually mirrored types + contract
tests" discipline (this contract-test package lives at `tests/contract`), using
ADR-0018's inline Draft-07 dialect. It is **not** a new architectural decision.

## Why a normalizer

The two emitters speak slightly different Draft-07 dialects. `normalize.ts`
reconciles them (each rule is commented with the quirk it cancels): strip
`$schema` (Effect-only), strip `title` (Effect combinator noise), empty
`required` ≡ absent (Rust omits, Effect emits `[]`), and deep key-sort (the two
order keys differently). Effect's per-combinator `description` noise (e.g. `minLength(1)` →
"a string at least 1 character(s) long") is suppressed at the source in
`packages/protocol/src/payloads.ts` so the one real `description` — the
`LocalDateTime` format hint — survives untouched.

## In scope (what turns CI red)

Structural drift across the Core↔Web seam, per kind:

- a field present on one side, absent on the other (presence);
- a field required on one side, optional on the other (optionality);
- a field's JSON type, `enum` domain, integer `minimum`, string `pattern`, or
  `minItems`/`minLength` bound differing between the sides.

A field added to `PayloadSpec` but forgotten in the Effect Schema (or vice versa)
turns the gate red. The Rust side re-runs in CI and `git diff --exit-code` over
`fixtures/` catches a Rust schema change that wasn't re-committed (staleness).

## Out of scope (by construction — not a gap)

This gate locks the **advertised wire schema's structure**, nothing more.

- **Cross-field invariants.** `status`↔timestamp coupling, the recurrence
  anchor-presence and inter-field couplings, exactly-one-`entity_ref` per
  reference, `ended_at >= occurred_at` — none are expressible as a flat schema
  walk. They live as hand-written hooks in `crates/core/src/entities.rs`, run
  after the structural check, and are **not** mirrored or compared here.
- **Deliberate schema≠validator divergences.** The fixtures mirror the
  *advertised schema* faithfully, including where it intentionally diverges from
  the runtime validator:
  - `entity_id` / `todo_id` advertise a **bare** `{type:string}` though the
    validator UUID-checks them;
  - `aliases` / `tags` / `remove_person_ids` advertise **plain** string elements
    (no `minLength`) though the validator requires each non-empty.
  Validators are not compared — only the schema both sides advertise.
- **The `{mutation_kind, payload, rationale}` envelope** / the top-level `oneOf`
  framing. That is Core-owned (a hand-built `json!` in the tool descriptor) and
  not duplicated on the Web; the fixtures are the `payload` body alone.

## Non-payload structs (ADR-0009 as-built)

The second leg covers the plain serde wire messages — those mirrored in
`protocol.rs` (serde) and `packages/protocol/src/index.ts` (Effect Schema) but
historically verified only per-side. It is **instance-based**, not
schema-vs-schema: the fixture is a real *serialized value*, so it dodges the
`skip_serializing_if` null-vs-omit lie a type-derived schema would introduce.

- **Core-emitted** (`fixtures/structs/emitted/`) — for Serialize-capable messages.
  `regenerate_struct_fixtures` (in `protocol.rs mod parity_fixtures`) serializes one
  canonical instance per message through the real serde path;
  `emitted_fixtures_match_committed` `include_str!`-locks them so `cargo test` bites
  on staleness. CI regenerates + `git diff`s this dir.
- **Hand-authored** (`fixtures/structs/authored/`) — for Deserialize-only params
  (the 13 `*Params`, `WorkerStdout`) Core never serializes. The fixture is the
  canonical wire JSON Web sends; `authored_fixtures_parse` asserts each
  deserializes. **Never** regenerated.

`src/structs.test.ts` decodes each fixture (`onExcessProperty: "error"`) and
re-encodes it back to deep-equal the fixture; `src/structs.registry.ts` pairs each
fixture with its Effect Schema; `src/structs.completeness.test.ts` locks the
message set + per-union variant counts. `normalize.ts` is **not** used here (it is
the payload gate's schema-dialect reconciler). The accepted blind spot — a field
optional on the TS side and absent on the Rust side — and the JSON-RPC envelope
(out of scope, no TS mirror) are recorded in ADR-0009's as-built section.

## Layout

```text
fixtures/<wire_kind>.json          the 15 Rust-emitted payload schemas (schema-of-record)
fixtures/structs/emitted/*.json    Core-emitted non-payload wire values (serialize side)
fixtures/structs/authored/*.json   hand-authored param wire JSON (deserialize side)
src/parity.test.ts                 per-kind payload deep-equality (schema-vs-schema)
src/completeness.test.ts           locks the 15-payload registry/fixtures/canonical sets
src/normalize.ts                   the dialect-reconciling normalizer (payload leg only)
src/structs.test.ts                per-message non-payload decode + re-encode (instance-based)
src/structs.registry.ts            fixture → Effect Schema registry + canonical message list
src/structs.completeness.test.ts   locks the message set + per-union variant counts
```

The TS payload schemas live in `packages/protocol/src/payloads.ts` (the `schemas`
registry), not in this package.

Regenerate the committed fixtures after a `PayloadSpec` change (payloads) or a
Serialize-capable wire-struct change (non-payload):

```shell
cargo test --manifest-path crates/core/Cargo.toml regenerate_schema_fixtures
cargo test --manifest-path crates/core/Cargo.toml regenerate_struct_fixtures
```
