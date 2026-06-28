# Backend timeline read model: a typed `(occurred_at, kind, ref)` union over canonical fact tables

/ builds on [ADR-0017](./0017-tier-2-schema-slice-1.md), [ADR-0030](./0030-journal-entry-anchored-capture.md), [ADR-0053](./0053-observation-records.md), [ADR-0029](./0029-request-handler-seam.md), [ADR-0009](./0009-protocol-strategy.md), [ADR-0004](./0004-three-tier-storage-authority.md), [ADR-0007](./0007-local-first-single-user.md); coexists with [ADR-0054](./0054-topic-navigation-browse-axis.md) §4.

Inkstone accrues time-bearing facts across more than one canonical table — Journal
Entries (the capture spine, ADR-0030) and Observations (tracker facts, ADR-0053) —
and product surfaces increasingly want to read them *as one chronology*: a unified
"what happened, in time order" stream. Until now there is **no backend timeline
model at all**. The only thing in the code named "timeline" is the intra-Run
*segment* timeline (ADR-0045, ordered by `run_steps.seq`, not by wall-clock time);
the only cross-entity "Timeline" is the client-side presentation projection of
ADR-0054 §4, composed in the web view-model from per-type `entity/list` reads. There
is no Core verb, no wire struct, no stored row that represents a domain-time event
spanning entity families.

Without a shared model, every future surface (a daily view, a calendar, a Health
readout, a cross-domain "history" panel) reinvents its own ordering and provenance
logic over the same tables — the exact divergence ADR-0017 avoided *inside* a Run by
making `run_steps` the sole sequencer. This ADR defines the cross-table analog: a
backend, design-only read model. It introduces **no production code** and **no stored
table**; it specifies the shape, the membership, the ordering rule, and the one Core
verb that a later implementation slice will build.

## Decision

**A Timeline Event is a `(occurred_at, kind, ref)` projection over canonical tables —
never a stored table and never a write target.** The canonical rows (`entities`,
`observations`) stay authoritative; the timeline is a *read*. Nothing writes "to the
timeline" — recording a Journal Entry or an Observation through its existing write
path *is* how an event comes to exist.

### 1. v1 membership: Journal Entries and Observations — the records that carry a domain `occurred_at`

A timeline is a record of **what happened** — facts and evidence with an authoritative
"when did this occur in the world" time. Exactly two canonical record families carry
such a time as a required, domain-meaningful field:

| Kind | Source table (filter) | Authoritative time | Real column (verified) |
| --- | --- | --- | --- |
| `journal` | `entities` where `type = 'journal_entry'` | `occurred_at` | `mutation.rs:714` — `Field::datetime("occurred_at").require()`; stored in `entities.data` JSON, read via `json_extract(data, '$.occurred_at')` |
| `observation` | `observations` | `occurred_at` (start); `ended_at` optional | `migration 0001_initial.sql:183` (`occurred_at TEXT NOT NULL`), `:184` (`ended_at TEXT`) |

Both fields are `LocalDateTime` — local wall-clock `YYYY-MM-DDTHH:MM:SS`, no timezone
(`field_spec.rs` `FieldSpec::LocalDateTime`, pattern `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$`).
Journal's `occurred_at` is `require()`d at validation; observation's is `NOT NULL` at
the column. **Every v1 event therefore has a present wall-clock `occurred_at` by
construction.**

The following are **deliberately not v1 timeline members**:

- **Todos — out-of-scope; a GTD-axis concern, not a happening.** A Todo's four
  authoritative times (`defer_at`, `due_at`, `completed_at`, `dropped_at` —
  `mutation.rs:351-354`, the four `clearable_datetime` fields) are *forward-looking
  intentions and resolution stamps*, not events that occurred. A Todo lives on the
  **GTD** browse axis (Inbox/Waiting/Scheduled/Review; ADR-0031/0032/0054), and its
  scheduling dates belong to a **calendar/forecast** axis ([#236](https://github.com/hongyilyu/inkstone/issues/236)),
  not the timeline. Todos are reserved out of v1. *(This narrows
  [#260](https://github.com/hongyilyu/inkstone/issues/260)'s acceptance criterion,
  which named "Journal Entries + Todos + observations"; see Considered and rejected.)*
- **Person / Project — reserved; no authoritative domain time.** They carry only
  `entities.created_at` (an ms-epoch storage stamp), not a domain "when this happened"
  field, so they would be all-fallback noise. ADR-0054 §4's *client* Timeline renders
  Person/Project chronologically as interaction history — a different surface (see §4
  coexistence below).
- **Media — reserved; the time does not exist.** A `captured_at` field is **reserved**
  for a future Media family; `grep -rn "captured_at" crates/` returns zero matches
  today, so Media contributes nothing to v1 by construction.

The `kind` discriminant is left an **open union** (mirroring the `Segment` enum of
ADR-0045): adding a future kind — Media when `captured_at` lands, or any new
domain-time-bearing family — is additive, not a reshape.

### 2. Ordering: one wall-clock sort key, no cross-representation conversion in v1

The single ordering authority is `occurred_at`, a wall-clock `YYYY-MM-DDTHH:MM:SS`
TEXT value — analogous to `run_steps.seq` being the sole sequencer for the segment
timeline. Because **both v1 members already store `occurred_at` as wall-clock TEXT**,
the union needs **no time conversion**: wall-clock strings sort lexically ⇔
chronologically, an invariant the codebase already banks on (`recurrence.rs:80` — "Wall-clock
strings sort chronologically, so a string compare is correct"). The journal arm reads
its time with the established `json_extract(data, '$.occurred_at')` pattern
(`queries.rs:1549` uses the same idiom on `entities.data`); the observation arm reads
the `occurred_at` column directly. The union is then one `ORDER BY occurred_at DESC`,
exactly as the observation list query already orders (`queries.rs:1139`), with a stable
`kind, ref_id` tiebreak.

**The `created_at` fallback (ms-epoch) is documented but inert in v1.** Inkstone stores
two time representations — domain times are wall-clock TEXT, while `created_at` /
`proposals.decided_at` / `messages.created_at` are INTEGER ms-epoch
(`0001_initial.sql:121,136,189`) — and Core never converts between them in SQL today
(zero `strftime`/`unixepoch`/`datetime(` hits in `crates/core`). The only
epoch→wall-clock bridge is Rust civil-date math at the global
`review_anchor_utc_offset_minutes` offset (`entities.rs:966`,
`settings.rs:23`, default `0`). For v1 that bridge is **never exercised**: both members
have a present wall-clock `occurred_at`, so no row falls back to `created_at`. The
fallback is specified only so a *future* kind lacking a domain time has a defined rule
— and that rule, when first needed, is the "strftime-T projection at the workspace
anchor offset" (`strftime('%Y-%m-%dT%H:%M:%S', created_at/1000, 'unixepoch', <offset>)`
— the literal `T` format, not `datetime()`'s space; the deterministic anchor offset,
not non-deterministic `'localtime'`). Building that conversion now would be machinery
v1 does not need.

### 3. Provenance is an event *attribute*, never a standalone event

A Proposal decision (`proposals.decided_at`, `0001_initial.sql:121`) and the source
Message that drove capture are **not** their own timeline events. They surface as an
event's optional `source`, resolved through the existing provenance tables —
`entity_sources` for a Journal Entry, `observation_sources` for an Observation
(ADR-0030/0053) — and thence to the deciding Proposal / origin Message. Provenance is
resolved *after* the ordered window is selected (a LEFT JOIN onto the union result, or
a batched follow-up keyed by the returned ids), so it never perturbs the sort — the
same discipline ADR-0045 uses to keep `run_steps` ordering pure.

### 4. Corrections are not events (non-goal)

`entity_revisions` and `observation_revisions` (the correction history, ADR-0053) are
**not** timeline events in v1. The timeline shows the **current state at its domain
time** — one event per live record, at that record's present `occurred_at`. Correction
history stays a per-record drilldown (a detail-pane concern), not a stream of
"corrected at" events. This is an explicit non-goal: a revision changes *what* an event
says, not *that* a new thing happened.

### 5. Materialization: a typed union read, NOT a materialized table

The timeline is a **typed union read assembled at query time behind one Core verb** —
**NOT a materialized table**, and **NOT a client-side union**. It is a single
`SELECT … UNION ALL … ORDER BY occurred_at` over the canonical tables, decoded into a
typed discriminated union (`TimelineEvent`), exactly the "one ordered query" stance
ADR-0017 took for `run_steps`. No new storage, no denormalized copy to keep
consistent, no write path.

- *Why not a materialized table?* It would be a second source of truth requiring
  dual-write consistency with `entities`/`observations` for zero capability the live
  union lacks — the denormalization hazard ADR-0045 rejected for `text`-beside-`segments`.
  At single-user local-first scale (ADR-0007/0004) the union over a small SQLite is
  cheap; a `from`/`to` window bounds it.
- *Why not a client-side union?* A pure client merge is *viable* at this scale (it is
  precisely what ADR-0054 §4 does, and what reference clients like t3code do — separate
  per-type arrays merged in the view layer). The backend verb is a **deliberate choice
  for a shared, testable ordering + provenance contract** that any consumer (web today,
  others later) inherits instead of re-deriving — not a structural necessity. This is
  the §4 coexistence, not a contradiction.

The verb is **`timeline/query`**, a read verb routed through the JSON-RPC method match
in `runs/mod.rs` and the ADR-0029 `handler::handle` combinator, mirroring
`observation/query` (`runs/observation.rs`) and `entity/list` (`runs/entity.rs`). Its
params are all-optional filters — `{ from?, to?, kinds?, limit? }` — following the
`ObservationQueryParams` precedent (`protocol.rs:486`). A `from`/`to` window is the
natural pagination unit for a calendar/timeline consumer and bounds the materialized
`Vec`; `kinds` lets a consumer ask for a subset (drop unmatched UNION arms); `limit` is
a safety cap. The result is the object-wrapper `{ items: [TimelineEvent] }` shape
(`ObservationQueryResult` / `EntityListResult` precedent).

## Relationship to ADR-0054 §4

**This ADR coexists with ADR-0054 §4 (different consumer).** ADR-0054 §4 is a
*client-side presentation projection* — the **Timeline Topic**, a chronological
rendering of **Journal Entry · Person · Project** composed in the web view-model from
`entity/list` rows and provenance reads, answering "show me my interaction history."
ADR-0057 is a *backend read model* — an ordered `(occurred_at, kind, ref)` stream of
**Journal Entries + Observations** behind `timeline/query`, answering "what facts
occurred, in time order, with a shared ordering contract."

They differ in **membership** (§4 has Person/Project and no Observations; 0057 has
Observations and no Person/Project) and in **altitude** (§4 is presentation with no
contract; 0057 is a backend wire contract). Neither subsumes the other: 0057 does not
reproduce §4's GTD-shaped, entity-centric interaction view, and §4 carries no
Observation chronology and no backend verb. A future client *may* consume
`timeline/query` for the fact-chronology portion of a unified surface — that would be
additive, never a supersession. **§4 is therefore annotated, not superseded.**

## The real trade-off

The honest cost is **membership narrowing**: a "timeline" that excludes Todos will feel
incomplete to anyone expecting their deadlines and completions on it, and #260 itself
listed Todos as a member. We accept that. A timeline that mixed forward-looking Todo
plans with past happenings would conflate two axes the product keeps separate — GTD
(what I intend to do) versus the timeline (what occurred) — and would force a single
sort column to mean both "scheduled for" and "happened at." Keeping Todos on the GTD
axis and the calendar/forecast axis (#236), and the timeline to genuine `occurred_at`
facts, is the cleaner model even though it diverges from the issue's first framing.

The second trade-off is **a backend contract for a derivable read**. At single-user
scale the client could merge the streams itself (§4 proves it). We pay one
parity-gated wire struct to buy a shared ordering+provenance contract, so the
ordering rule lives and is tested in one place rather than re-derived per surface. The
cost is real and atomic (see Consequences); the benefit is that "what is the canonical
order of events" stops being a per-feature decision.

## Consequences

- **A new result struct enters the contract-parity gate (ADR-0009).** `TimelineQueryResult`
  is a Core-emitted result, so the implementation slice moves **atomically**: the Rust
  mirror + `fx!` emitted-fixture entry + `include_str!` committed-table line
  (`protocol.rs`), the committed fixture JSON under
  `tests/contract/fixtures/structs/emitted/`, the Effect Schema
  (`packages/protocol/src/index.ts`), and the registry row + `CANONICAL_MESSAGES` entry
  (`tests/contract/src/structs.registry.ts`) — or the gate reds. `TimelineEvent` is a
  leaf, covered transitively inside the wrapper fixture (the `ObservationRow`-inside-`ObservationQueryResult`
  precedent); a tagged-union event additionally pins a `UNION_VARIANTS` count.
- **The implementation slice touches a known, narrow set:** `runs/mod.rs` (a `mod
  timeline;` + a `"timeline/query"` match arm), a new `runs/timeline.rs` handler through
  `handler::handle`, `protocol.rs` (params + result + row structs + a mirror test +
  fixture), `packages/protocol/src/index.ts`, and `tests/contract/src/structs.registry.ts`.
  The JSON-RPC router is `runs/mod.rs`; `dispatcher.rs` (the Workflow dispatcher,
  ADR-0011/0024) is **unrelated and untouched**.
- **No migration, no new table, no write path.** Pre-release or not, there is nothing
  to migrate — the model is a read over tables that already exist.
- **Adding a future kind is additive.** When Media's `captured_at` lands, or any new
  domain-time family arrives, it becomes a new `kind` variant + a new UNION arm — the
  open union absorbs it without reshaping existing events.

## Considered and rejected

- **Include Todos as timeline events (per #260's literal criterion).** Rejected:
  conflates the GTD axis (forward-looking intentions) with the timeline (past
  happenings) and forces one sort column to mean both "scheduled for" and "occurred
  at." Todos stay on GTD; their scheduling dates belong to the forecast axis (#236). A
  Todo's `completed_at`/`dropped_at` could later justify a resolution-only event kind,
  but that is a deliberate future addition, not v1.
- **A materialized `timeline_events` table.** Rejected: a second source of truth needing
  dual-write consistency with the canonical tables, for no capability the query-union
  lacks at single-user scale (§5).
- **A per-source RPC (one read per family, merged by the client).** Rejected: that is
  the client-union, which already exists as ADR-0054 §4; the whole point of 0057 is one
  shared ordering+provenance contract behind one verb. (Were the typed-union read ever
  proven insufficient at scale, a per-source or materialized design would be
  reconsidered — but not before.)
- **Order by `created_at` (ms-epoch) for uniformity.** Rejected: `created_at` is a
  storage stamp, not the domain time; ordering a Journal Entry by when its row was
  written rather than by `occurred_at` would misplace back-dated captures. Order by the
  domain `occurred_at`; keep `created_at` only as the (inert in v1) fallback.
- **Superseding ADR-0054 §4.** Rejected: different membership and different altitude
  (see Relationship). The client Timeline Topic keeps its Person/Project interaction
  view; 0057 is the backend fact chronology.

## Related

- [ADR-0017](./0017-tier-2-schema-slice-1.md) — `run_steps` as the sole sequencer / "one
  ordered query"; this ADR is the cross-table analog (a query-union, not a stored order).
- [ADR-0030](./0030-journal-entry-anchored-capture.md) — Journal Entry `occurred_at` and
  the `entity_sources` provenance the event's `source` reads.
- [ADR-0053](./0053-observation-records.md) — Observation `occurred_at`/`ended_at`, the
  `observation_sources` provenance, and `observation/query`, the read verb
  `timeline/query` mirrors.
- [ADR-0029](./0029-request-handler-seam.md) — the `handler::handle` combinator the read
  verb routes through.
- [ADR-0009](./0009-protocol-strategy.md) — manually mirrored protocol structs and the
  contract-parity gate the result struct joins.
- [ADR-0045](./0045-assistant-turn-segment-timeline.md) — the open `#[serde(tag="kind")]`
  discriminated-union precedent (`Segment`) the `TimelineEvent` kind mirrors, and the
  "don't denormalize beside the union" discipline.
- [ADR-0054](./0054-topic-navigation-browse-axis.md) §4 — the client-side Timeline Topic
  projection; **coexists with ADR-0054 §4 (different consumer)** — see Relationship.
- [ADR-0007](./0007-local-first-single-user.md) / [ADR-0004](./0004-three-tier-storage-authority.md)
  — single-user local-first scale is why a query-union (not a materialized table) is the
  right altitude.
- Tracked: [#260](https://github.com/hongyilyu/inkstone/issues/260) (this model; v1
  membership narrowed to JE + Observations). Calendar/forecast axis for Todo scheduling:
  [#236](https://github.com/hongyilyu/inkstone/issues/236).

## Appendix: implementation sketch (non-normative — no production code ships with this ADR)

The eventual slice would add the verb and structs. Shapes below are illustrative,
mirroring `observation/query`.

```rust
// protocol.rs — mirrors ObservationQueryParams (all-optional filters).
#[derive(Debug, Default, Deserialize)]
pub struct TimelineQueryParams {
    #[serde(default)] pub from: Option<String>,   // wall-clock "YYYY-MM-DDTHH:MM:SS", inclusive
    #[serde(default)] pub to: Option<String>,     // exclusive upper bound
    #[serde(default)] pub kinds: Option<Vec<String>>, // subset of {"journal","observation"}
    #[serde(default)] pub limit: Option<i64>,
}

// An open, kind-tagged union — mirrors the Segment enum (ADR-0045).
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum TimelineEvent {
    #[serde(rename = "journal")]
    Journal {
        occurred_at: String,                 // the sort key (wall-clock TEXT)
        entity_id: String,                   // ref back to the canonical row
        source: Option<TimelineSourceView>,  // entity_sources → message / proposal
    },
    #[serde(rename = "observation")]
    Observation {
        occurred_at: String,
        ended_at: Option<String>,
        observation_id: String,
        schema_key: String,
        source: Option<TimelineSourceView>,  // observation_sources → message / entity
    },
}

#[derive(Debug, Serialize)]
pub struct TimelineQueryResult { pub items: Vec<TimelineEvent> }
```

```sql
-- The query-union: one UNION ALL, one outer ORDER BY, no time conversion.
-- (A requested `kinds` subset omits the unmatched arm entirely.)
SELECT json_extract(e.data, '$.occurred_at') AS occurred_at,  -- wall-clock TEXT, required
       'journal' AS kind, e.id AS ref_id
  FROM entities e
 WHERE e.type = 'journal_entry'
   AND (:from IS NULL OR json_extract(e.data, '$.occurred_at') >= :from)
   AND (:to   IS NULL OR json_extract(e.data, '$.occurred_at') <  :to)
UNION ALL
SELECT o.occurred_at AS occurred_at,                          -- wall-clock TEXT column, NOT NULL
       'observation' AS kind, o.id AS ref_id
  FROM observations o
 WHERE (:from IS NULL OR o.occurred_at >= :from)
   AND (:to   IS NULL OR o.occurred_at <  :to)
 ORDER BY occurred_at DESC, kind, ref_id
 LIMIT :limit;
-- Provenance (source) is resolved AFTER this ordered window — a LEFT JOIN onto
-- entity_sources/observation_sources keyed by ref_id, or a batched follow-up read —
-- so it never perturbs the sort.
```
