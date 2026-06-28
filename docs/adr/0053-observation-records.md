# Observation records for high-volume tracker facts

Inkstone needs to grow into exercise, nutrition, habits, sleep, bodyweight, mood,
and similar tracker domains without turning each stream into a new Entity Type,
sidebar row, proposal kind, and duplicated read/write path.

## Decision

Add **Observation** as a second tier-2 content family alongside Canonical
Entities.

Canonical Entities remain the closed, compile-checked noun set: Journal Entry,
Person, Project, Todo, Bookmark, and rare future identity-bearing objects such
as a Habit definition. Observations are timestamped tracker facts validated by a
Core-owned schema registry: `bodyweight`, `nutrition.intake`,
`exercise.session`, `habit.checkin`, and similar streams.

Observation records use their own storage and client/Core verbs rather than
being rows in `entities`:

- `observations` stores the common envelope: schema key/version, occurred time,
  optional ended time, values JSON, note, provenance origin, and timestamps.
- `observation_sources` stores optional evidence/provenance pointing at exactly
  one Message or Entity. Its `CHECK` pins `relation` to the id column it rides —
  `(entity AND created_from) XOR (message AND evidenced_by)` — tighter than the
  plan's 2-value CHECK, which left `relation` unconstrained. It also diverges
  structurally from `entity_sources`: it drops the `updated_from` relation and
  adds `UNIQUE(observation_id)` (one original source; corrections live in
  `observation_revisions`), versus `entity_sources`' 3-relation multi-source
  shape. Reconciling the two source tables is tracked by #266.
- The first client/Core surface is `observation/record` and
  `observation/query`.
- Agent-reviewed capture later uses one generic `record_observations` proposal
  kind, not one proposal kind per tracker stream.

The first proving slice is `bodyweight`: relation-free, decimal-valued, and
queryable by schema/time. Correction starts as delete-and-re-record; update
history waits for a real edit surface.

## Why separate from `entities`

A same-table design is viable: `entities.type` is plain text, existing reads are
type-filtered, and observation-like rows would not automatically appear in
today's Library reads.

The separate table is still the cleaner long-term module because observations
have different dominant access patterns and invariants:

- high-volume time-range reads,
- tracker-specific source/evidence queries,
- later aggregate views,
- no lifecycle or Library identity by default,
- no need to grow the closed Entity Type enum for every tracker stream.

The cost is real: observation storage needs helper twins instead of pretending
the entity helpers are table-generic. That cost is accepted to keep the Entity
module about identity-bearing nouns and the Observation module about
timestamped facts.

## Validation shape

Observation schemas are Core-owned static descriptors, not runtime plugins.
Unknown schema keys are rejected.

Validation is two-stage:

1. A flat envelope and values walk checks required fields, scalar types, enum
   domains, local datetime shape, and schema-specific value fields.
2. A schema hook checks cross-field invariants, such as `ended_at >= occurred_at`.

Relation-bearing observations split validation again: the pure values walk only
checks UUID shape; existence and target Entity Type checks run in the write
transaction because they require database reads.

## Consequences

- Adding a tracker stream usually adds one observation schema, not an Entity
  Type, sidebar row, proposal kind, or custom RPC method.
- Journal Entries remain evidence anchors, not mandatory parents.
- UI navigation is decoupled from both Entity Types and observation schemas.
- The protocol parity gate applies to the new client/Core record/query structs.
- Observation schemas remain Core-owned until skill-authored schemas have a real
  use case.

## Related

- [ADR-0004](./0004-three-tier-storage-authority.md) - tier-2 SQLite is
  authoritative for Core-owned content.
- [ADR-0009](./0009-protocol-strategy.md) - manually mirrored protocol structs
  and contract parity.
- [ADR-0014](./0014-client-core-wire-protocol.md) - client/Core JSON-RPC method
  namespaces.
- [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md) - direct
  user writes can persist without synthetic proposals.
