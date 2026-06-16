# @inkstone/contract — wire-schema parity gate

A CI gate that proves the **Rust** and **TypeScript** definitions of the wire
`payload` for the 13 agent-proposable Workspace mutations agree, per kind.

- **Rust** (`crates/core`) is the schema-of-record. An inline test
  (`regenerate_schema_fixtures` in `src/tools/propose_workspace_mutation.rs`)
  dumps each kind's `MutationKind::payload_spec().json_schema()` — the same
  expression that drives the agent tool descriptor — to `fixtures/<wire_kind>.json`.
- **TypeScript** (`src/schemas.ts`) hand-authors one Effect Schema per kind.
  `parity.test.ts` runs each through `JSONSchema.make`, runs both it and the Rust
  fixture through `normalize.ts`, and asserts deep-equality.

This implements ADR-0009's already-decided "manually mirrored types + contract
tests" discipline (this contract-test package lives at `tests/contract`), using
ADR-0018's inline Draft-07 dialect. It is **not** a new architectural decision.

## Why a normalizer

The two emitters speak slightly different Draft-07 dialects. `normalize.ts`
reconciles them (each rule is commented with the quirk it cancels): strip
`$schema` (Effect-only), inline `$ref` + drop `$defs` (Effect hoists `S.Int`;
Rust inlines), strip `title` (Effect combinator noise), empty `required` ≡ absent
(Rust omits, Effect emits `[]`), and deep key-sort (the two order keys
differently). Effect's per-combinator `description` noise (e.g. `minLength(1)` →
"a string at least 1 character(s) long") is suppressed at the source in
`schemas.ts` so the one real `description` — the `LocalDateTime` format hint —
survives untouched.

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

## Layout

```text
fixtures/<wire_kind>.json   the 13 Rust-emitted schemas (the schema-of-record)
src/schemas.ts              kind → Effect Schema registry + shared sub-schemas
src/normalize.ts            the dialect-reconciling normalizer
src/parity.test.ts          the per-kind deep-equality assertions
```

Regenerate the fixtures after any `PayloadSpec` change:

```shell
cargo test --manifest-path crates/core/Cargo.toml regenerate_schema_fixtures
```
