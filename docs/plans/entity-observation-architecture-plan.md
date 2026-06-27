# Entity + Observation Architecture Plan

Status: Draft for review
Date: 2026-06-26

## Locked Decisions

This plan records the architecture direction after reviewing the entity-capability
proposal, the log-as-stream proposal, and the visualization review.

The core decisions are:

1. **Canonical Entity Types use entity-type specs.**
   Existing and future first-class nouns stay closed and compile-checked, but
   their policy moves into explicit specs instead of being scattered across Core
   and Web.

2. **Tracker records use a separate observations table.**
   Exercise sessions, nutrition intake, bodyweight, habit check-ins, sleep, mood,
   and similar high-volume time-series records do not become peer Entity Types.
   They live in an observation module with its own storage and query surface.

3. **UI navigation can decide later.**
   The Core architecture must not force one sidebar row per Entity Type or per
   observation schema. Navigation is a product/view decision over the data, not
   a side effect of registering a type.

The pattern is:

```text
closed nouns, open records

canonical entities      -> identity-bearing domain objects
observations            -> timestamped tracker facts
derived views           -> UI/read projections over both
navigation              -> product-owned workflows and collections
```

## Goal

Inkstone needs to grow into domains like exercise, nutrition, habits, sleep, and
mood without turning every future thing into:

- a new permanent Library row,
- a new Entity Type enum variant,
- a new create/update/delete proposal family,
- a new detail/editor branch,
- a new query path copied across Core and Web,
- or a fat generic trait that every type pretends to implement.

The architecture should make common behavior cheap without erasing domain
meaning.

## Non-Goals

- Do not replace existing JournalEntry, Person, Project, Todo, or Bookmark
  behavior with a generic graph.
- Do not add one proposal kind per tracker, such as `create_exercise` or
  `create_calorie`.
- Do not make observations appear in the Library sidebar by default.
- Do not let skills invent arbitrary unvalidated observation shapes.
- Do not build charts, dashboards, or Health navigation as part of the Core
  architecture decision.
- Do not make Journal Entry the mandatory parent of every observation.

## Architecture Overview

```text
user / skill / agent
        |
        v
capture intent
        |
        +--> journal-worthy narrative?
        |         |
        |         v
        |   JournalEntry entity
        |         |
        |         v
        |   optional evidence link
        |
        v
classify payload
        |
        +--> needs identity / lifecycle / refs?
        |         |
        |         v
        |   canonical entity
        |   Person / Project / Todo / Habit definition
        |
        +--> timestamped tracker fact?
                  |
                  v
            observation
            exercise.session / nutrition.intake / habit.checkin
```

Read flow:

```text
entities table       -----+
                          +--> derived views --> UI
observations table   -----+     Today / Health / Review / Search
```

Journal Entry remains important, but its role is precise:

```text
JE = narrative / evidence anchor
JE != mandatory parent of every structured record
```

## Domain Vocabulary

### Canonical Entity

A durable object with identity and domain behavior.

Examples:

- JournalEntry
- Person
- Project
- Todo
- Bookmark
- Habit definition, if/when habit definitions need identity

Canonical Entities are stored in `entities`, have revisions, and remain
compile-checked through a closed `EntityType` enum.

### Entity Type Spec

A Core-owned policy record for one canonical Entity Type.

It answers:

- stored type string,
- schema version,
- data field shape,
- create/update/delete support,
- proposal support,
- referenceability,
- listability,
- title/search projection,
- relation hooks,
- write semantics.

This is not a runtime plugin system. It is a static table that makes the
checklist explicit and local.

### Observation

A timestamped fact or event in a tracker stream.

Examples:

- `exercise.session`
- `nutrition.intake`
- `bodyweight`
- `habit.checkin`
- `sleep.segment`
- `mood.rating`

Observations have their own storage, validation, source/evidence, and time-range
query surface. Revision history is deferred until an edit/correction view proves
that it is needed.

### Observation Schema

A Core-owned descriptor for one observation shape.

It answers:

- schema key,
- schema version,
- label,
- field spec for `values`,
- relation fields that must point at a specific Entity Type,
- time semantics,
- envelope validation hook,
- relation fields that need apply-time database checks,
- global-search inclusion, if any.

Observation schemas are open-ended over time, but they are not arbitrary blobs at
write time. Unknown schema keys are rejected.

### Derived View

A read projection over entities, observations, or both.

Examples:

- Today
- Inbox
- Review
- Health dashboard
- streaks
- weekly totals

A derived view is authoritative for nothing. It can be rebuilt from stored
entities and observations.

### Navigation View

A product-owned UI entry point.

Examples:

- Chat
- Search
- Today
- Inbox
- Review
- Library
- Health

Navigation is not the type list. Registering an Entity Type or Observation
Schema does not automatically create a top-level navigation row.

## Core Module Shape

### 1. Entity Type Spec Module

The Entity module keeps the current polymorphic storage kernel and closes over a
static entity spec table. This is a locked architecture direction, but it is not
on the critical path for the first observation slice. Do the low-churn
consolidation first, and move write dispatch only when a sixth canonical type
earns the refactor.

Illustrative Rust shape:

```rust
pub(crate) struct EntityTypeSpec {
    pub entity_type: EntityType,
    pub stored_type: &'static str,
    pub schema_version: i64,
    pub data_spec: fn(Mode) -> PayloadSpec,
    pub title: fn(&serde_json::Value) -> Option<String>,
    pub search_text: fn(&serde_json::Value) -> Vec<String>,
    pub referenceable: bool,
    pub listable: bool,
}
```

Start with fields that have a proven second reader. Do not pre-load the spec with
every possible write hook; `MutationKind::describe()` and the existing apply
paths already encode write policy today.

Initial spec rows:

- JournalEntry
- Person
- Project
- Todo
- Bookmark

Potential later spec row:

- Habit definition

The important rule: a new canonical Entity Type should be rare and intentional.

### 2. Observation Module

The Observation module is a separate deep module with a small external
interface.

Core-facing interface:

```text
record_observations(input) -> observation ids
delete_observation(id) -> ok
query_observations(filter) -> observations
```

The names can change, but the shape should stay small:

- one write path for recording observations,
- one delete path,
- one query path by schema/time/source/entity relation.

Do not add one path per schema.

Correction starts as delete-and-re-record. Add `update_observation` and
observation revisions only when there is a real edit surface.

### 3. Observation Schema Registry

Core owns a static schema registry.

Illustrative shape:

```rust
pub(crate) struct ObservationSchema {
    pub key: &'static str,
    pub version: i64,
    pub label: &'static str,
    pub values_spec: fn() -> PayloadSpec,
    pub validate_values: fn(&serde_json::Value) -> Result<(), String>,
    pub validate_record: fn(&ObservationRecordDraft) -> Result<(), String>,
    pub relation_fields: &'static [ObservationRelationField],
    pub global_searchable: bool,
}
```

The registry gives us one place to answer:

- Is this schema key known?
- Which version is current?
- What values are valid?
- Which envelope-level invariants must hold?
- Which fields point at Entity IDs?
- Can this observation appear in global search?

Skills and agents can use observation schemas. They should not define schemas in
the first architecture.

Validation is two-stage:

1. A flat field walk validates the envelope and `values` shape.
2. Schema hooks validate cross-field facts that a flat walk cannot express.

For example, `ended_at >= occurred_at` cannot live in `values_spec`, because
`occurred_at` and `ended_at` are envelope fields. It belongs in
`validate_record`, mirroring the existing Journal Entry hook for
`ended_at >= occurred_at`.

## Storage

Use separate observation tables.

### Considered: Same Table With `entities.type = schema_key`

A same-table design is viable in the current schema:

- `entities.type` is plain text,
- `entity/list` is an exact type-filtered read,
- observation-like rows would not automatically appear in existing Library
  reads,
- existing entity revision/source helpers could be reused.

The separate table decision is still preferred because observations have a
different dominant access pattern:

- high-volume time-range reads,
- tracker-specific source/evidence queries,
- later aggregate reads,
- no need to treat tracker records as Library items,
- clearer separation between identity-bearing nouns and timestamped facts.

This choice has a real implementation cost. The storage layer needs observation
twins of the entity helpers instead of pretending the existing entity helpers are
table-generic:

- insert observation,
- delete observation,
- query observations by schema/time,
- insert observation source,
- attach source views to observation rows,
- check source rows,
- check relation target type inside the write transaction.

Budget that work explicitly in the first slice.

### First-Slice Schema

Start without observation revisions. Correction is delete-and-re-record until an
edit UI proves revision history is needed.

```sql
CREATE TABLE observations (
  id                       TEXT PRIMARY KEY,
  schema_key               TEXT NOT NULL,
  schema_version           INTEGER NOT NULL,
  occurred_at              TEXT NOT NULL,
  ended_at                 TEXT,
  values                   TEXT NOT NULL,
  note                     TEXT,
  created_by               TEXT NOT NULL CHECK (created_by IN ('user','proposal')),
  created_via_proposal_id  TEXT REFERENCES proposals(id),
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  CHECK (
    (created_by = 'user' AND created_via_proposal_id IS NULL) OR
    (created_by = 'proposal' AND created_via_proposal_id IS NOT NULL)
  )
);

-- This intentionally diverges from the looser entities check. Observation
-- provenance has only two first-slice origins, so a direct user row must not
-- carry a proposal id, and a proposal-born row must carry one.

CREATE INDEX idx_observations_schema_time
  ON observations(schema_key, occurred_at);

CREATE INDEX idx_observations_time
  ON observations(occurred_at);
```

Observation sources:

```sql
CREATE TABLE observation_sources (
  id                 TEXT PRIMARY KEY,
  observation_id     TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  source_entity_id   TEXT REFERENCES entities(id) ON DELETE CASCADE,
  source_message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
  relation           TEXT NOT NULL CHECK (relation IN ('created_from','evidenced_by')),
  created_at         INTEGER NOT NULL,
  CHECK (
    (source_entity_id IS NOT NULL AND source_message_id IS NULL) OR
    (source_entity_id IS NULL AND source_message_id IS NOT NULL)
  ),
  UNIQUE (observation_id)
);

-- Observations start with created_from and evidenced_by only. There is no
-- updated_from relation while correction is delete-and-re-record.

CREATE INDEX idx_observation_sources_observation
  ON observation_sources(observation_id);

CREATE INDEX idx_observation_sources_source_entity
  ON observation_sources(source_entity_id);

CREATE INDEX idx_observation_sources_message
  ON observation_sources(source_message_id);
```

Why separate tables:

- Observation reads are naturally time-range reads.
- Observation volume can grow much faster than canonical entities.
- Observation schemas should not bloat Library `entity/list`.
- Aggregation and Health views should query observations without pretending they
  are Library items.

### Deferred Revision Schema

If/when observations gain a real edit surface, add observation revisions:

```sql
CREATE TABLE observation_revisions (
  observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  values         TEXT NOT NULL,
  note           TEXT,
  occurred_at    TEXT NOT NULL,
  ended_at       TEXT,
  proposal_id    TEXT REFERENCES proposals(id),
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (observation_id, seq)
);
```

## Observation Data Shape

Each observation row has common envelope fields:

```json
{
  "id": "uuid",
  "schema_key": "exercise.session",
  "schema_version": 1,
  "occurred_at": "2026-06-26T18:00:00",
  "ended_at": "2026-06-26T19:10:00",
  "values": {},
  "note": "optional"
}
```

The `values` object is schema-specific and validated by Core.

Examples:

```json
{
  "schema_key": "bodyweight",
  "occurred_at": "2026-06-26T07:30:00",
  "values": {
    "kg": 75.4
  }
}
```

```json
{
  "schema_key": "nutrition.intake",
  "occurred_at": "2026-06-26T21:00:00",
  "values": {
    "kcal": 2310,
    "protein_g": 180,
    "carbs_g": 210,
    "fat_g": 70
  }
}
```

```json
{
  "schema_key": "habit.checkin",
  "occurred_at": "2026-06-26T09:00:00",
  "values": {
    "habit_id": "habit-uuid",
    "state": "done",
    "quantity": 1
  }
}
```

## Validation Rules

Core validation should reject:

- unknown `schema_key`,
- missing `schema_version`,
- unsupported schema version,
- invalid `occurred_at`,
- `ended_at` before `occurred_at`,
- non-object `values`,
- missing required schema fields,
- wrong scalar types,
- unknown enum values,
- invalid relation targets,
- relation fields pointing at the wrong Entity Type.

Tracker data needs a decimal-capable field shape.

Add a bounded `FieldSpec::Number` leaf before shipping decimal streams such as
bodyweight or nutrition macros.

Recommended shape:

```rust
FieldSpec::Number {
    min: Option<f64>,
    max: Option<f64>,
    integer: bool,
}
```

Rules:

- JSON number only.
- finite `f64` only.
- `integer: true` rejects decimals.
- `min` and `max` are inclusive when present.

Examples:

- `bodyweight.kg`: `Number { min: Some(0.0), max: None, integer: false }`
- `nutrition.kcal`: `Number { min: Some(0.0), max: None, integer: true }`
- macro grams: `Number { min: Some(0.0), max: None, integer: false }`

## Time Semantics

Use the existing local wall-clock style for input fields.

Recommended envelope:

- `occurred_at`: required local date-time string.
- `ended_at`: optional local date-time string.
- query filters accept `from` and `to` local date-time strings.
- local-day grouping is a read policy, not stored UI state.

Questions to avoid in the first slice:

- multi-timezone travel semantics,
- recurring schedule generation,
- chart bucketing beyond simple day/week/month grouping.

The Observation module should still keep time-range queries explicit from day
one, because that is the main reason observations have their own table.

## Lifecycle

Observations are append-mostly facts. The first correction model is
delete-and-re-record.

Rules:

- create writes an `observations` row.
- delete removes the observation and cascades sources.
- direct user/skill writes have `created_by = 'user'`.
- proposal-born writes have `created_by = 'proposal'` and proposal id.

Add update and revision history only when the product has an edit surface that
needs it. Until then, observation storage stays separate and small.

## Evidence And Sources

Observation evidence is optional.

Allowed capture paths:

```text
direct user tracking entry
  -> observation
  -> no source required

skill logs workout/nutrition
  -> observation
  -> source optional, usually message if available

journal-worthy message
  -> JournalEntry entity
  -> extracted observation
  -> observation_sources points to the JournalEntry

agent-proposed tracking record
  -> proposal
  -> observation
  -> created_via_proposal_id set
```

Journal Entry is evidence, not ownership.

Do not store `journal_entry_id` inside arbitrary observation `values` unless a
schema actually needs it as domain data. Provenance belongs in
`observation_sources`.

## Relations To Entities

Observation-to-entity relations should start schema-specific.

Examples:

- `habit.checkin.values.habit_id` must point at an accepted `Habit` entity.
- a future `exercise.session.values.program_id` might point at a `Project` or a
  future `TrainingProgram` entity if that domain earns identity.

Do not introduce a generic relationship graph yet.

Validation is split:

```text
field habit_id:
  value shape = uuid
  relation target = EntityType::Habit
```

The pure schema walk validates that `habit_id` is a UUID-shaped field. Existence
and Entity Type validation require a database read, so they run during the write
transaction, like Todo's `project_id` recheck.

That means relation validation is write-time validation. JSON fields do not get
database-level cascade behavior. If Habit definitions are added, Habit deletion
must choose a concrete rule. Recommended first rule:

```text
refuse to delete a Habit while habit.checkin observations reference it
```

Do not use "preserve orphan label" as the default; it needs extra stored
snapshot fields and UI policy.

## Proposal Surface

Pin the surfaces separately:

- `observation/record` and `observation/query` are client/Core RPC verbs for Web
  and other client-side callers.
- Agent/skill access is through Core tools, not raw RPC frames.
- Agent-reviewed observation capture uses the proposal tool with one generic
  `record_observations` mutation kind.

If silent skill persistence is needed before proposal support, add a Core tool
that records observations directly. Do not imply an agent can emit
`observation/record` as a JSON-RPC frame.

Do not add:

```text
create_exercise
update_exercise
delete_exercise
create_calorie
update_calorie
delete_calorie
```

Use one generic proposal kind if/when proposal review is needed:

```text
record_observations
```

Payload shape:

```json
{
  "observations": [
    {
      "schema_key": "exercise.session",
      "occurred_at": "2026-06-26T18:00:00",
      "ended_at": "2026-06-26T19:10:00",
      "values": {},
      "note": "optional"
    }
  ],
  "evidence": {
    "journal_entry_id": "optional",
    "message_id": "optional"
  }
}
```

Rules:

- proposal kind is generic,
- schema validation still happens per observation,
- one proposal can record multiple observations if they came from the same
  capture,
- proposal parity is paid once for the generic proposal kind,
- no parity growth per tracker stream.

Direct user write path can exist before proposal support:

```text
observation/record
```

This mirrors the Bookmark precedent at the mutation-payload level:
user-authored data does not have to pass through agent proposal review. It does
not avoid the normal wire-struct contract gate for new RPC params/results.

## Query Surface

Observation reads should not use `entity/list`.

Core query interface:

```text
observation/query
  schema_keys?: string[]
  from?: local datetime
  to?: local datetime
  source_entity_id?: uuid
  source_message_id?: uuid
  limit?: number
```

Return shape:

```json
{
  "observations": [
    {
      "id": "uuid",
      "schema_key": "bodyweight",
      "schema_version": 1,
      "occurred_at": "2026-06-26T07:30:00",
      "ended_at": null,
      "values": { "kg": 75.4 },
      "note": null,
      "source": null,
      "created_at": 123,
      "updated_at": 123
    }
  ]
}
```

Start with plain reads. Aggregates can be derived in Web or a later query module.
Do not add cursor pagination until a real dataset requires it; current analogous
single-user reads use `limit` first.

Add `related_entity_id` only with the first relation-bearing schema, such as
`habit.checkin` in Phase 3.

Possible later query:

```text
observation/aggregate
  schema_key
  metric
  bucket = day | week | month
  range
```

Do not add aggregate queries until a real view needs them.

## Search And Reference Policy

Observations are queryable by tracking views by default.

Global search is opt-in per schema.

Recommended defaults:

- `bodyweight`: not global-searchable.
- `nutrition.intake`: not global-searchable initially.
- `habit.checkin`: not global-searchable initially.
- `exercise.session`: maybe searchable later if sessions have titles/notes.

Journal Entry inline references to observations should wait.

Reason:

- Entity refs currently target canonical entities.
- Observation refs add a second target family and UI semantics.
- The first value is Health/tracking views, not inline backlinking.

## Web Shape

UI details can decide later, but Web should mirror the Core separation.

Possible later modules:

```text
LibraryEntityModule
  for canonical entities

NavigationView
  for sidebar/workflow entries
```

Do not add Web module infrastructure before it has a second real consumer. The
first observation view can use a small local display map for the shipped schemas.

The important UI rule:

```text
new Entity Type      does not automatically mean top-level nav row
new ObservationSchema does not automatically mean top-level nav row
```

Health can be one future navigation view over observations. The exact layout,
charts, stream filters, pinned views, and dashboard composition can wait.

## Promotion Rule

A new concept starts in the cheapest shape that preserves authority.

Use a Derived View when:

- it is just a read/projection,
- it can be recomputed,
- it has no identity.

Use an Observation when:

- it is timestamped,
- it is high-volume,
- it is a measurement/event/check-in,
- it wants time-range reads.

Use a Canonical Entity when:

- it needs stable identity,
- users edit it as an object,
- it has lifecycle transitions,
- it can be referenced,
- it owns domain relations.

Use a Domain Workflow when:

- users act through it,
- it orchestrates multiple objects,
- it is not itself stored as domain data.

Examples:

| Concept | Shape | Reason |
| --- | --- | --- |
| Habit definition | Canonical Entity | identity, cadence, target, status |
| Habit check-in | Observation | timestamped, high-volume |
| Calories | Value inside `nutrition.intake` | measured value, not object |
| Workout session | Observation first | timestamped session; promote only if sessions need rich identity |
| Health dashboard | Derived View | read projection over observations |
| Weekly review | Domain Workflow | user acts through it |

## Phased Plan

### Phase 1: Observation Proving Slice

Goal: prove the separate observation substrate end to end with the smallest real
schema.

First schema:

- `bodyweight`
- relation-free
- decimal value
- validates `FieldSpec::Number`

Core:

- add `observations`,
- add `observation_sources`,
- add observation storage helpers,
- add `ObservationSchema`,
- add `FieldSpec::Number`,
- add `bodyweight` schema,
- add `observation/record`,
- add `observation/query`,
- use delete-and-re-record for correction.

Protocol:

- add `ObservationRecordParams`,
- add `ObservationRecordResult`,
- add `ObservationQueryParams`,
- add `ObservationQueryResult`,
- add Effect schemas,
- add contract fixtures for the four new wire structs,
- update the non-payload struct registry.

Validation:

- unknown schema rejected,
- invalid values rejected,
- decimal values accepted where schema allows,
- `ended_at < occurred_at` rejected through the envelope hook,
- direct write creates observation with `created_by = 'user'`,
- query filters by schema/time and supports `limit`,
- source constraints enforced when evidence is supplied,
- no proposal kind is added.

### Phase 2: Optional Entity Type Spec Consolidation

Goal: move entity policy toward specs without blocking observations.

Core:

- add a minimal `EntityTypeSpec`,
- move stored string, schema version, referenceability, and title/search
  projection into specs only where this reduces current duplication,
- keep `EntityType` and `MutationKind` closed,
- do not move high-risk write dispatch until a new canonical type forces it.

Validation:

- test every existing Entity Type has a spec,
- test unknown stored type behavior stays explicit,
- test referenceability/listability are declared.

This phase can happen before or after the proving slice. It should pair naturally
with Habit definition if Habit becomes the sixth canonical Entity Type.

### Phase 2b: Habit Definition If Needed

Goal: add Habit as the first post-spec canonical Entity Type only if it has
earned identity.

Core:

- add `EntityType::Habit`,
- add an `EntityTypeSpec` row,
- add direct CRUD,
- decide proposal support later.

Validation:

- Habit data validates cadence/target/status,
- Habit search/title projection works through the spec,
- Habit does not automatically create a top-level nav row.

### Phase 3: Relation-Bearing Observation Schema

Goal: prove schema-specific relation validation only when a real relation exists.

Likely schema:

- `habit.checkin`, after Habit definition exists.

Core:

- add relation field declarations to `ObservationSchema`,
- validate UUID shape in the pure values walk,
- validate existence and target Entity Type in the write transaction,
- define Habit delete behavior before shipping check-ins.

Recommended Habit delete behavior:

```text
refuse delete while habit.checkin observations reference the Habit
```

Validation:

- check-in rejects malformed `habit_id`,
- check-in rejects missing Habit target,
- check-in rejects non-Habit target,
- Habit delete is blocked while check-ins reference it.

### Phase 4: Generic Observation Proposal

Goal: allow agent-reviewed observation capture without per-stream proposal kinds.

Core/protocol:

- add `record_observations` proposal kind,
- add protocol schema once,
- add fixtures/parity once,
- apply writes observations and sources.

Validation:

- one proposal can contain multiple observations,
- bad observation rejects without partial apply,
- proposal-born rows record proposal id,
- no new proposal kind is needed when adding a new schema.

### Phase 5: Observation Correction History

Goal: add update/revision history only when an edit surface needs it.

Core:

- add `observation_revisions`,
- add `update_observation`,
- append a revision on update,
- keep delete semantics explicit.

Validation:

- create writes revision seq 1 only after revisions exist,
- update appends seq n+1,
- failed update writes no revision,
- query returns current observation state.

### Phase 6: UI Views

Goal: present observations without binding Core architecture to sidebar shape.

Web:

- add observation query hook,
- add simple Health/tracking read view,
- add stream filters,
- keep charts optional,
- keep nav pinning separate from schema registration.

Validation:

- adding an observation schema does not add a sidebar row,
- Health can read observations,
- Library still reads canonical entities separately.

## Testing Strategy

Core tests:

- entity specs cover every Entity Type,
- observation schema registry rejects unknown keys,
- observation record validates envelope and values,
- observation sources enforce exactly one source kind,
- observation relation fields validate UUID shape in the pure walk,
- observation relation fields validate target existence/type in the write
  transaction,
- observation query filters by schema/time,
- direct writes do not require fake proposals,
- proposal writes are atomic,
- observation revisions append correctly once the correction-history phase exists.

Protocol tests:

- direct observation record/query schemas decode expected payloads,
- direct observation record/query params/results are covered by the non-payload
  struct parity gate,
- `record_observations` parity is locked if/when proposal support lands,
- adding a new observation schema does not change proposal kind count.

Web tests:

- observation rows parse separately from Library entity rows,
- Library nav does not derive from observation schemas,
- Health/tracking views can query observations by schema/time,
- malformed observation rows are isolated to observation views.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Observation table becomes an untyped JSON dump | Core-owned `ObservationSchema` registry and required validation |
| Separate storage duplicates entity infrastructure | Budget observation helper twins explicitly; share validation helpers where useful, not storage paths |
| Every observation becomes searchable noise | Search is opt-in per schema |
| UI gets coupled to schema registration | Navigation registry stays product-owned |
| Agent proposals grow per stream | One `record_observations` proposal kind |
| Relation validation needs database reads | Pure schema checks UUID shape; apply-time transaction checks existence and Entity Type |
| Habit check-ins need Habit before Habit exists | Ship bodyweight first; add Habit definition before `habit.checkin` |
| Habit delete leaves JSON references dangling | Refuse Habit delete while check-ins reference it, unless a cleanup mechanism is explicitly built |
| Time semantics balloon | Start with local wall-clock range queries and day grouping; defer timezone complexity |
| Aggregation engine appears too early | Start with plain query; derive aggregates in view code until demand proves Core aggregation |

## Success Criteria

The architecture is working when:

- adding a canonical Entity Type changes one Entity Type spec before domain
  behavior,
- adding an observation schema does not add an Entity Type,
- adding an observation schema does not add a sidebar row,
- adding an observation schema does not add a proposal kind,
- observations are validated by Core, not opaque blobs,
- observation reads use time-range queries, not `entity/list`,
- JE can source observations without owning them,
- Habit definition and Habit check-in are represented by different shapes,
- UI can choose later whether Health is one view, many views, or mostly command
  driven.

## Open Questions For Later Review

These do not block the Core architecture.

1. Which first observation schema should ship?
2. Should Health be a pinned nav view or live under Library/Search first?
3. Should observations ever be inline-reference targets from Journal Entry body?
4. Should Core expose aggregate queries, or should Web derive aggregates for a
   while?
5. Should skills eventually be able to contribute schemas, or should Core remain
   the only schema author?

The recommended default is to keep schemas Core-owned until there are multiple
real schemas and one real case where skill-owned schema authorship would remove
more complexity than it adds.
