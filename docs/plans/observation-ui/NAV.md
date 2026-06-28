# Health topic — interior information architecture (NAV)

> **Scope.** Resolves the five interior questions ADR-0054 deferred to
> [#253](https://github.com/hongyilyu/inkstone/issues/253), before #253 (the
> Observations read surface) and [#255](https://github.com/hongyilyu/inkstone/issues/255)
> (the corrections entry point) build. **Decision record only** — no contract, no
> migration, no ADR file, no backend surface. The decisions below are STATED, not TBD.

## Why this note

ADR-0054 fixed the **outer** nav: Health is one closed topic row
(`apps/web/src/components/library/TopicNav.tsx:34`), shipped as a placeholder until
#253. It deliberately deferred the **interior** of Health — how observation streams
render *inside* that one topic — to #253 (the deferral lives at
`docs/adr/0054-topic-navigation-browse-axis.md:46` in the nav list, and at `:204` in
the Related ADR-0053 entry). This note locks that interior so #253/#255 build against a
settled IA rather than re-opening it. It asserts the same stance ADR-0054 took for the
outer nav: **zero contract, migration, or backend change** — the entire interior is a
presentation/projection over reads that already exist.

## Decisions

### 1. One Health surface, schema-grouped — **no per-schema nav**

There is **one** Health surface. Schemas are *in-view facet groups* over a single
observation read, never navigation entries. The closed topic set stays exactly four
rows (`TopicNav.tsx:32-35`: GTD · Timeline · Health · Media); Health is one row
(`:34`) and **no per-schema nav** entry is ever added — adding bodyweight or
habit.checkin as a sidebar row would re-introduce the flat-row growth ADR-0054 retired.
Facet grouping happens *inside* the Health view, computed client-side from the single
`observation/query` read, exactly as ADR-0054 decision 1 mandates ("Openness lives
*inside* a topic … never in the topic set itself").

- **Anchor:** `apps/web/src/components/library/TopicNav.tsx:32-35` (the closed `TOPICS`
  array — stays unchanged; Health at `:34`).

### 2. First-class schemas: none get nav entries

No observation schema is promoted to a nav entry. The two **shipped** facet groups are
`bodyweight` and `habit.checkin` — the only keys `schema_for` resolves today
(`crates/core/src/observations.rs:499`, arms at `:501-502`). A row whose `schema_key`
is unknown to the registry (`schema_for` returns `None`, `:503`) **degrades to its raw
key + a values-JSON dump and never crashes** — the #253 Slice-2 fallback. New tracker
streams therefore appear automatically as new facet groups when their schema lands; no
nav edit, no #253 follow-up.

- **Anchor:** `crates/core/src/observations.rs:499` (`fn schema_for`; `bodyweight` →
  `:501`, `habit.checkin` → `:502`, unknown → `None` `:503`).

### 3. Time-series rendering ≠ Library cards

Health renders a **calm, dense, chronological stream** keyed by `occurred_at`, **not**
the Library card/detail/rail surfaces. The row shape is `ObservationRow`
(`crates/core/src/protocol.rs:518`), ordered by its `occurred_at` field (`:522`). It
reuses **none** of `EntityRow` (`apps/web/src/components/library/EntityRow.tsx`),
`EntityDetail` (`.../EntityDetail.tsx`), or `FocusedEntityRail`
(`.../FocusedEntityRail.tsx`) — those render identity-bearing nouns with lifecycle,
inspector, and backlinks; observations have none of that.

The **dividing rule**: identity-bearing nouns (Journal Entry, Person, Project, Todo,
Bookmark) render as Library cards with a detail rail; **high-volume timestamped facts**
render as a chronological stream. This is precisely the access-pattern split ADR-0053
drew to justify a separate table — "high-volume time-range reads … no lifecycle or
Library identity by default"
(`docs/adr/0053-observation-records.md:41-47`). The renderer follows storage's grain:
facts stream, nouns card.

- **Anchors:** `crates/core/src/protocol.rs:518` (`struct ObservationRow`, `occurred_at`
  at `:522`); `docs/adr/0053-observation-records.md:41-47` (the access-pattern /
  identity dividing rule).

### 4. Source round-trip

The **forward** direction — observation → its evidence — reuses the existing "Captured
from" affordance via `ObservationSourceView` (`crates/core/src/protocol.rs:506`),
carried on `ObservationRow.source` (`protocol.rs:526`). It is shown **only when
present**: a user-recorded observation with no evidence row serializes `source` as
explicit `null` (the row's documented nullable convention, `protocol.rs:514-516`), and
the UI renders nothing rather than an empty "Captured from" stub.

The **back** direction — a Journal Entry / message → its observations — is already
served by `observation/query`'s `source_entity_id` / `source_message_id` filters
(`ObservationQueryParams`, `protocol.rs:495-497`); it needs **no new read**. Surfacing
that link in the UI is therefore an optional #253 affordance over an existing read, not
a deferred contract.

- **Anchor:** `crates/core/src/protocol.rs:506` (`ObservationSourceView`); back-direction
  filters at `protocol.rs:495-497`.

### 5. Corrections / history discovery

The entry point #255 wires is **`observation/update`** — routed at
`crates/core/src/runs/mod.rs:114` (the dispatch arm; handler `handle_update` at `:115`).
A correction is a **full-replace of the fact fields**: `ObservationUpdateParams` takes
the target id plus a source-free replacement draft, provenance stays immutable, and the
prior values are appended to `observation_revisions`
(`protocol.rs:466-468`). The UI entry point is an "edit / correct this record" action on
a stream row, opening the same value editor #253's facet groups already need.

`observation_revisions` has **no read RPC** — the only `observation/*` verbs are
`record`, `update`, and `query` (`mod.rs:111-118`); the table is written on correction
but never served. So **history-viewing is out-of-scope** for #253/#255: the UI surfaces
*making* a correction (full-replace), not *browsing* the revision trail. A
revision-history reader is future work and would require a new read RPC + parity-gate
slice — explicitly not in this scope.

- **Anchor:** `crates/core/src/runs/mod.rs:114` (`observation/update` dispatch; handler
  `:115`); correction semantics at `protocol.rs:466-468`.

## Contract / migration / backend impact: none

Mirroring ADR-0054's stance for the outer nav, the Health interior is a presentation
projection over reads that already exist (`observation/query`, `ObservationRow`,
`ObservationSourceView`) and the one mutation that already exists (`observation/update`).
This note introduces **no** protocol struct, **no** parity-gate slice, **no** migration,
**no** new read RPC, and **no** per-schema route. If a #253/#255 slice is found to need
any of those, that is a signal the slice has drifted from this note and must be
re-scoped — the same guard ADR-0054 placed on its own slices.

## Unblocks

- **#253** — Observations read surface: builds the single schema-grouped Health stream
  (decisions 1–4) over `observation/query`.
- **#255** — Corrections: wires the `observation/update` edit affordance (decision 5),
  history-viewing excluded.
