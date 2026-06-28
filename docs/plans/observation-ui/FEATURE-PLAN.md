# Thin Observations read surface in web (#253)

> Grounded against Core tip `8b814322` (origin/master, includes #251/#268). Every
> `file:line` below was re-grepped at authoring time. This is a **web + ui-sdk only**
> change — **no Core, no protocol, no migration**: the contract (`ObservationRow`,
> `ObservationQueryResult`, the `observation/query` verb) and its parity fixtures are
> already shipped; we **consume**, never re-author.

## Goal

Make the **Health** topic real: a thin, **read-only** web surface that queries
observations and renders them as a calm, day-grouped chronological stream — `bodyweight`
and `habit.checkin` polished, any unknown `schema_key` degrading to key + values-JSON
**without crashing**. Closes the read-path gap (the agent *write* path — the proposal
card — already ships).

## The decided shape (locked, not open)

- **View axis** — one Health surface, a **chronological stream keyed by `occurred_at`**,
  newest first, **day-grouped** with sticky day headers (mirrors the sole in-repo
  sibling `TimelineView`; honors NAV.md D3 "chronological stream" + the issue's "grouped
  list"). Schemas are **in-view facet filter chips**, never sections and never nav rows
  (NAV.md D1, literal "no per-schema nav"). NOT a KPI grid, NOT `EntityRow` cards, NOT
  charts.
- **Health is its own topic.** Observations never appear in the Timeline view (Timeline
  stays JE · Person · Project). We reuse TimelineView's *visual idiom*, not its data.
- **Evidence** — "Captured from" is a **display-only** label, shown only when
  `row.source != null`. Forward deep-link (observation → its JE/message) and back-link
  (source → its observations) are out of scope (NAV.md D4 defers the back-direction;
  forward deep-link is a fast-follow, not part of a "thin" surface).
- **Read-only.** No correction/delete/quick-add UI. NOTE: Core correction verbs
  (`observation/update`, `observation_revisions`) *did* land (#268), so read-only is a
  deliberate **scope** boundary (corrections = #255), not a Core gap. We do not consume
  `ObservationUpdateParams`.

## Verified ground truth (anchors @ `8b814322`)

| Claim | Anchor (verified) |
| --- | --- |
| Read-side wire types shipped | `packages/protocol/src/index.ts`: `ObservationQueryParams` :200, `ObservationSourceView` :213 (`relation` is `S.Literal("created_from","evidenced_by")`), `ObservationRow` :220 (`values: S.Unknown`, `ended_at`/`note`/`source` are `S.NullOr`), `ObservationQueryResult` :234 |
| ui-sdk has **zero** observation verbs | `grep observation packages/ui-sdk/src/index.ts` = 0 hits |
| WsClient interface / impl / `.of` return | `packages/ui-sdk/src/index.ts`: interface :194-253 (`listEntities` :229), impls :596-705 (`listEntities` :596), `WsClient.of({…})` return :707-735 |
| The round-trip test to mirror | `packages/ui-sdk/src/index.test.ts:262` (`listEntities(type)` sends `entity/list`, round-trips `EntityListResult`) |
| Parity gate already covers the result | `tests/contract/fixtures/structs/emitted/observation_query_result.json` exists → **Slice 1 adds no fixture** |
| `bodyweight` value shape | `{ kg: number ≥ 0 }` — `crates/core/src/observations.rs:507`; TS draft mirror `packages/protocol/src/payloads.ts:412` |
| `habit.checkin` value shape | `{ habit_id: uuid (→ Habit entity), state: "done"\|"skipped"\|"missed", quantity?: number }` — `observations.rs:528-558`; TS draft mirror `payloads.ts:416`. **Brief omitted `quantity` (optional).** |
| Habit is **not** surfaced in web; no name resolver | `grep habit apps/web/src` → only `ProposalCard.test.tsx`. → `Habit · <short-id>` (truncated `habit_id`) is the only honest rendering |
| Renderer to "extract" is NOT schema-aware | `apps/web/src/components/ProposalCardObservations.tsx:58` `renderObservationBody` dumps `values` via `JSON.stringify` (:24) over **untyped proposal payloads**; never branches on `schema_key`. Reusable primitive = `ObservationField` (:47) + JSON fallback (:24). The schema-aware display map is **new**. |
| Hook to mirror | `apps/web/src/lib/hooks/useLibraryItems.ts` (`useQuery` + `runtime.runPromise(program)`; rejects on Core-unreachable so empty ≠ failed; pure assembler separable) |
| View idiom to mirror | `apps/web/src/components/library/TimelineView.tsx` (day-grouped `<ol>` :119, sticky `<h2>` day header :121-124, quiet rows `rounded-lg border border-border/60 px-4 py-3` :129; empty/error via `EmptyState`); chips = rounded-full `<button aria-pressed>` (TimelineView :88-94, count badge GtdView :187-191) |
| Date + grouping helpers | `formatDay` `apps/web/src/lib/libraryItems.ts:414`; day-bucket pattern `groupJournalEntriesByDay` :646 (`slice(0,10)`, day keys `b.localeCompare(a)` desc) |
| Route wiring to mirror | `apps/web/src/routes/library/timeline.tsx` (route owns `?filter=` via `validateSearch`; view is controlled/pure) |
| Health is a stub today | `apps/web/src/routes/library/health.tsx:5` renders `<StubTopic … issue={253}>` |
| **Blast is 33 files, not ~25** | 33 test files spell out the full `WsClient.of({…})` literal; **no shared stub helper** (`apps/web/src/test-utils/` has only render helpers). `WsClient.of` type-requires every field → adding `observationQuery` breaks all 33 at `tsc`. |

## Components

| File | Change |
| --- | --- |
| `packages/ui-sdk/src/index.ts` | **edit** — add `observationQuery` to the interface (:229 area), the impl (`request("observation/query", {…params}, ObservationQueryResult)`, :596 area), and the `WsClient.of({…})` return (:707) |
| `apps/web/src/lib/observationView.ts` | **new** — pure leaf: `OBSERVATION_VIEWS: Record<string, ObservationView>` (`bodyweight`, `habit.checkin`) + graceful unknown fallback; decodes `ObservationRow` into a view model |
| `apps/web/src/lib/hooks/useObservations.ts` | **new** — `useQuery(["observations"])` mirroring `useLibraryItems` (Effect program over `WsClient.observationQuery`, reject-on-unreachable) |
| `apps/web/src/lib/observationLog.ts` (or in `observationView.ts`) | **new** — pure `groupObservationsByDay(rows)` mirroring `groupJournalEntriesByDay` |
| `apps/web/src/components/library/HealthView.tsx` | **new** — calm day-grouped stream + schema filter chips + display-only "Captured from"; mirrors `TimelineView` idiom |
| `apps/web/src/components/ProposalCardObservations.tsx` | **edit (small)** — export the shared `ObservationField` primitive (+ JSON-value fallback) so the new view reuses it instead of forking |
| `apps/web/src/routes/library/health.tsx` | **edit** — replace `StubTopic` with `HealthView` wiring (mirror `timeline.tsx`) |
| 33 `*.test.tsx` with `WsClient.of({…})` | **edit (mechanical)** — add `observationQuery: () => unused` (or equiv) to each literal |

## Test infra (exists — reuse)

- **ui-sdk:** `packages/ui-sdk/src/index.test.ts` `makeServer`/`provide` WebSocket harness (the `listEntities` test at :262 is the template).
- **web units:** vitest; `renderWithQuery`/`renderChatRoute` in `apps/web/src/test-utils/`.
- **CI gate:** `pnpm check` (tsc -b) + `pnpm -r test` (vitest). apps/web e2e is **not** a gate.

## Vertical slices

### Slice 1 — contract: `observationQuery` on `WsClient`
- **RED test** (`packages/ui-sdk/src/index.test.ts`): `observationQuery(params)` sends method `observation/query` with `{…params}` and round-trips `ObservationQueryResult` — mirror the :262 `listEntities` test; assert `observed.method === "observation/query"` and the result equals the server payload.
- **Impl:** add the interface signature, the `request(…)` impl, and the `WsClient.of` return entry. Read verb only.
- **Blast:** add `observationQuery: () => unused` to all **33** exhaustive `WsClient.of({…})` literals (tsc-enforced; no shared helper exists to absorb it).
- **Acceptance:** `pnpm check` green; round-trip test passes; **no new parity fixture** (the emitted fixture already exists).

### Slice 2 — `observationView.ts` (schema-aware decode + fallback) + `useObservations`
- **RED tests** (`observationView.test.ts`): (a) a `bodyweight` row → polished display (`72.4 kg`); (b) a `habit.checkin` row → polished (`Habit · <short-id>` + `done`/`skipped`/`missed`, `quantity` when present); (c) an **unknown `schema_key`** → renders key + values-JSON and **does not throw** (mutation-test this — the fallback is the point). (d) `useObservations` mirrors `useLibraryItems` loading/empty/error (reject-on-unreachable surfaces as `isError`, not `[]`).
- **Impl:** `OBSERVATION_VIEWS` open `Record<string, ObservationView>` (per-schema `summary`/fields) + fallback branch; re-decode `row.values` against the draft value schema (`payloads.ts`) keyed on `schema_key`; reuse the exported `ObservationField` primitive. `useObservations` hook + separable pure `groupObservationsByDay`.
- **Acceptance:** unit tests green; `pnpm check` green.

### Slice 3 — `HealthView` + route (make Health real)
- **RED test** (`HealthView.test.tsx`): renders a day-grouped list from a mocked `useObservations`; clicking a schema chip filters the stream; "Captured from" appears **only** when `source != null`; the empty + error branches render distinct states; Health is no longer the stub.
- **Impl:** `HealthView` (TimelineView idiom: sticky day headers, quiet bordered rows, rounded-full filter chips with count badges, `EmptyState` for empty/error); rewire `health.tsx` to mount it (mirror `timeline.tsx`, schema filter in `?…`); drop the `StubTopic` usage there.
- **Acceptance:** component test green; `pnpm check` + `pnpm -r test` green.

### Slice 4 — DEFERRED (do not build)
Direct quick-add via `observation/record`. Out of scope for #253.

## Out of scope

Corrections/delete UI and revision history (#255); quick-add (Slice 4); charts/KPIs/dashboards; Habit name resolution (no web resolver exists); source deep-linking (display-only here); any Core / protocol / migration / parity-fixture change.

## ADRs

**None new.** Consumes ADR-0053 (observation records), ADR-0054 (topic nav), and the interior IA in `docs/plans/observation-ui/NAV.md`. Read-only is the NAV.md D5 boundary; "no per-schema nav" is NAV.md D1.
