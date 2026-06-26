# User-configurable model and effort; model leaves the Workflow TOML

A user picks **which model** the assistant uses and a **global effort level** from
the Web Client. Both are persisted by Core and override what a Workflow's TOML
declares. This amends [ADR-0018](./0018-workflow-and-tools-definition.md) (which
authored `model`/`thinking_level` in the Workflow TOML) and builds on the
Dispatcher seam from [ADR-0011](./0011-per-run-workflow-dispatch.md).

## Decision

- **Model and effort are user settings**, persisted in tier-2 SQLite, not authored
  per-Workflow in TOML. A `settings` key-value table holds `model:<workflow_name>`
  (the preferred model for a Workflow) and `effort` (the single global thinking
  level). Keyed by workflow name so a second Workflow later needs no migration.
- **The Workflow TOML `model` and `thinking_level` become optional.** Production
  `workflows/default.toml` drops both; they remain in the struct as an ultimate
  fallback so test fixtures (the `faux` provider workflow) stay self-contained.
- **Per-provider default** supplies the model when the user has not chosen:
  `openai-codex → gpt-5.5`. The global effort defaults to `off` ("non-reasoning").
- **Resolution happens at Run creation, after dispatch.** A new
  `resolve_effective_workflow` step clones the dispatched Workflow and overrides
  its model/effort using the order below, producing an **owned** `Workflow`
  (the Dispatcher still returns the `&'static` base; `worker::spawn` now takes an
  owned `Workflow`):

  | Field | 1st | 2nd | 3rd |
  |---|---|---|---|
  | `model` | user setting for the Workflow | per-provider default | TOML `model` |
  | `thinking_level` | global `effort` setting (default `off`) | TOML | `off` |

- **The wire `WorkerManifest` is unchanged.** `model`/`thinking_level` stay
  required strings — the resolver guarantees concrete values before spawn — so the
  ADR-0009 manifest mirror is untouched. `runs.model`/`runs.provider`
  ([ADR-0017](./0017-tier-2-schema-slice-1.md)) snapshot the resolved values.
- **New JSON-RPC methods** (mirrored TS+Rust per
  [ADR-0009](./0009-protocol-strategy.md)): `model/catalog` (available models per
  provider), `settings/get`, `settings/set` (validates model ∈ catalog and effort ∈
  the six thinking levels, rejecting with `invalid_params` per
  [ADR-0014](./0014-client-core-wire-protocol.md)).
- **The model catalog is a JSON file embedded in Core** (`include_str!`),
  hand-mirrored from `pi-ai`'s `MODELS["openai-codex"]`. Each `ModelInfo` carries
  `id`, `name`, `reasoning`, and `input` (capabilities) — no cost fields: the user
  is OAuth-billed against their own ChatGPT account (ADR-0023), so a per-token cost
  tier signals nothing actionable, and the catalog table shows capability chips
  (Vision / Reasoning), not a cost badge. A Worker-side test guards drift: it
  imports `pi-ai`'s catalog, projects it to that retained subset, and asserts
  equality, so a `pi-ai` bump that changes the model set fails CI rather than
  silently diverging. This is the ADR-0009 "hand-mirror + contract test"
  discipline applied to the catalog.

## Why these choices

- **Per-provider default, not per-Workflow matrix.** Exactly one Workflow exists
  (`default`), so a per-Workflow picker would render a single confusing row. Model
  is fundamentally a provider-capability choice; a per-provider default plus a
  single "preferred model" matches how the user reasons. Keying persistence by
  Workflow name keeps the door open without building the matrix now.
- **Effort is one global knob.** The product decision is a single effort level
  applied to whatever model runs, not a per-model setting (t3.chat surfaces effort
  per-message in the composer; we centralize it in settings).
- **Catalog embedded + drift-tested, not worker-provided at boot.** Spawning the
  Worker to enumerate models would couple Core boot to the TS toolchain and add an
  async dependency to a read path. An embedded JSON guarded by a contract test is
  synchronous, dependency-light, and matches ADR-0009.

## What this does not decide

- **Per-Workflow model matrices.** Reopens when a second Workflow ships; the
  Workflow-name-keyed storage already supports it.
- **Multiple providers / BYOK API keys.** Only `openai-codex` (OAuth, ADR-0023) is
  connectable. The catalog schema is provider-keyed and forward-compatible.
- **Hot reload of settings into in-flight Runs.** Resolution is read at Run
  creation; a setting changed mid-Run affects the next Run, not the running one.

## Considered and rejected

- **Keep `model` required in TOML, override silently.** Rejected: the production
  TOML would still "specify a model," contradicting the goal and leaving two
  sources of truth for the same fact.
- **A single global preferred model (not per-provider).** Adequate today but does
  not generalize once a second provider connects; per-provider default is the same
  effort now and scales.
- **Worker-provided catalog at boot.** Rejected for the coupling/async reasons
  above; the embedded-JSON-plus-drift-test path is simpler.

## Related

- [ADR-0011](./0011-per-run-workflow-dispatch.md) — Dispatcher seam; resolution is
  a new post-dispatch step, dispatch itself is unchanged.
- [ADR-0018](./0018-workflow-and-tools-definition.md) — amended: model/effort no
  longer authored in TOML for production; the fields stay optional fallbacks.
- [ADR-0017](./0017-tier-2-schema-slice-1.md) — `runs` snapshots the resolved
  provider/model; a new `settings` table joins tier 2.
- [ADR-0023](./0023-provider-oauth-core-owned-credentials.md) — provider
  connection state (`provider/status`) feeds the settings UI.
- [ADR-0009](./0009-protocol-strategy.md) — hand-mirrored schemas + contract tests,
  applied to the new methods and the model catalog.
- [ADR-0021](./0021-web-client-styling.md) — the settings page styling (Tailwind v4
  tokens, Inter, base-ui primitives).
