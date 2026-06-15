# Diagnostic logs are structured `tracing` events on a rolling JSONL file, keyed by a stable `event`

Inkstone emits **diagnostic logs** — the operational trail of what Core and the Worker did and where they faulted — as structured [`tracing`](https://docs.rs/tracing) events written to a **rolling JSONL file** in the OS application-data directory, next to the SQLite database. Each event carries a **stable machine key** (`event = "domain.thing_happened"`) plus typed key-value fields; variable data (ids, counts, error kinds) lives in **fields, never interpolated into the human message**. Verbosity is one knob — the `INKSTONE_LOG` env var, default `INFO` — and the trail's sole consumer is an **agent-driven hardening loop**: a reviewer (human or agent) greps/aggregates the file (`rg`, `jq`, `GROUP BY event`) to find recurring faults and drive root-cause fixes.

This replaces the ~31 ad-hoc `eprintln!`/`println!` diagnostic sites in Core and the Worker's stdout-only error surfacing. Before this ADR there was **no logging substrate at all**: no `tracing`/`log` dependency, no persisted artifact, no levels, no correlation. Diagnostics went to stdout/stderr and vanished.

## What a Diagnostic Log is *not* (the disambiguation)

Three concepts in this codebase are easy to conflate; this ADR adds the third and pins all three:

- **Run Event** ([ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md), [ADR-0006](./0006-run-events-vs-tool-protocol.md)) — the *ephemeral wire signal* Core forwards to Clients during a Run (`text_delta`, `done`, `error`, `cancelled`). Observed by Clients, not durable, not for operators.
- **Run Log** ([ADR-0028](./0028-run-status-materialized-transitions.md), CONTEXT §Storage) — Core's *durable tier-2 record of a Run's lifecycle milestones* (`running`/`parked`/`done`/…), authoritative domain state, written by the status-transition verbs. It is **not** diagnostics: it has no levels, no fault detail, no stack context, and answers "what milestones did this Run hit?", not "what broke and why?".
- **Diagnostic Log** (this ADR) — the *operational fault/trace trail* for hardening. Not authoritative for anything (a tier-3-like derived artifact, lossy and rotatable), not on the wire, not read by the product. If the file is deleted, no product behavior changes.

A Diagnostic Log line and a Run Log row may describe the same moment (a Run errored) but serve different readers through different channels. The `event` key namespace (`worker.*`, `db.*`, `subscribe.*`, `core.*`, `handler.*`) is deliberately disjoint from the Run Log Kind vocabulary so the two never read as the same thing.

## Substrate: `tracing` + `tracing-subscriber`, not `log` or a hand-rolled sink

`tracing` is the ecosystem default and the only choice that earns its dependency here:

- **Spans give correlation for free.** A `worker_run` span carrying `%run_id`, `.instrument()`'d onto the spawned Run task, attaches `run_id` to every event emitted inside that task — including transitive `sqlx`/`tokio` dep events — without threading it through each call site. (Note: `tokio::spawn` does *not* propagate the ambient span into the spawned future, so the span is attached explicitly via `.instrument(span)`, not a bare `#[instrument]` attribute, which would silently lose correlation across the spawn boundary.)
- **Canonical correlation field: top-level `run_id`.** The agent-queryable correlation key is a **direct, top-level** event field, emitted as `%run_id` at every site where `run_id` is in scope. This is load-bearing for the feature's purpose: with the JSON subscriber's `flatten_event(true)`, a *direct* event field lands at top-level `.run_id`, whereas a field carried only by the enclosing **span** lands at `.span.run_id`. A trail that mixed the two would defeat the one query the feature exists to serve — `jq 'select(.run_id=="…")'` / `GROUP BY run_id` would silently miss every span-only event. Therefore:
  - Sites with `run_id` in scope (most of `run.rs`, `mod.rs`) emit it **directly**: `error!(event="worker.terminal_tx_failed", %run_id, …)`.
  - Sites without it in scope (`child.rs`'s stdout reader) get `run_id` **threaded in** (into `ChildWorker::spawn`) so they too emit the top-level field.
  - The `worker_run` span is **retained** anyway, because it is the only way to correlate the transitive `sqlx`/`tokio` events (which we don't author and can't add a field to) — those remain joinable via `.span.run_id`.
  - The canonical, documented query path is **top-level `.run_id`**; `.span.run_id` is a fallback for dep events only.
- **It captures the dependencies' events.** `sqlx`, `tokio`, and `tower` already emit `tracing` events transitively (they are in `Cargo.lock` today). A `tracing` subscriber picks these up; `log` + `env_logger` would not, and a hand-rolled macro would reimplement levels, filtering, span propagation, and formatting to capture nothing extra.
- **The structured-event discipline is native.** `warn!(event = "db.fts_index_failed", %run_id, error = %e)` is the idiomatic form, and the JSON layer serializes fields as JSON object keys — exactly the shape `jq`/`GROUP BY` wants.

`log` + `env_logger` (no spans, no structured fields, no dep-event capture) and a hand-rolled SQLite-backed logger (reimplements the above, and couples the trail to the DB this project nukes freely in dev) were rejected — see below.

## Sink: a rolling JSONL **file**, not a SQLite table

The trail lands as `<data-dir>/inkstone/logs/core.jsonl` (Core) and a sibling `worker.jsonl` (Worker), via `tracing-appender`'s daily rolling appender with `max_log_files` ≈ 7 so the directory does not grow unbounded. The data-dir resolution mirrors `db::path` (`crates/core/src/db/mod.rs`, the `INKSTONE_DB_PATH` resolver): a `INKSTONE_LOG_DIR` analog with the same OS-data-dir default (and `logging::resolve_log_dir` reuses `db::os_data_dir`, so the log dir and DB dir cannot drift). The Worker's sink is a single appended file rather than a rolling set, so its path is a full file path; Core resolves `<log-dir>/worker.jsonl` and hands it to the spawned Worker as `INKSTONE_WORKER_LOG_PATH` **by default** (an explicit env value overrides), so the Worker half of the trail is written in normal operation without any operator action — not merely when the path is set.

A file, not a `logs` SQLite table, because:

- **It decouples from the DB.** §5 of the project's working principles nukes local DBs without ceremony; logs of *why* a run failed must survive a DB reset, and must not bloat the authoritative store. A tier-3-like artifact belongs outside tier 2.
- **`jq`/`rg` over JSONL is sufficient for the one consumer.** "Top recurring faults" is `jq -r .event | sort | uniq -c | sort -rn` — no schema, no migration, no writer to own. SQL aggregation is a nicer query surface but does not justify a custom `tracing` Layer + rotation/retention logic + DB coupling at this stage.

JSONL on **stdout** was also rejected: Core's stdout carries the `INKSTONE_*` liveness markers the Test Harness parses (see below), and interleaving a high-volume JSON stream there invites accidental coupling. The file is cleaner and is what the read-the-file review loop assumes.

## The `INKSTONE_*` stdout markers stay; logs do not migrate onto them

`main.rs` prints `INKSTONE_LISTENING <url>`, `INKSTONE_RECOVERED …` on stdout. The Test Harness (`crates/core/tests/common/mod.rs`) blocks on the literal `INKSTONE_LISTENING` prefix (with its trailing space) to learn Core's ephemeral port. These markers are a **liveness/boot protocol**, not diagnostics, and they **stay on stdout verbatim** — they are *not* folded into the `tracing` layer. A diagnostic event may *also* record boot (`event = "core.listening"`) for the file trail, but the stdout marker remains the harness's contract. Keeping the two separate avoids reworking the marker-parsing tests and keeps the boot protocol legible.

There is **no pretty stderr layer** in v1, so `pnpm dev`'s terminal stays quiet for diagnostics — the trail is the file. A human-facing stderr layer is a trivial later addition (a second `tracing-subscriber` layer behind the same filter) and is deliberately out of scope now.

## `run_id` reaches the Worker out-of-band (env), for now

The Worker has no `run_id` today: `WorkerManifest` carries none, and `transport-stdio.ts` hardcodes `run_id: ""` in outbound frames. For `worker.jsonl` lines to join to `core.jsonl` by run, Core passes `INKSTONE_RUN_ID` as a **spawn-time env var** to the Worker child (`crates/core/src/worker/child.rs`), mirroring the existing `INKSTONE_WORKER_TOOL_CALL_LOG`/`INKSTONE_WORKER_CMD` env plumbing. The Worker reads `process.env` and stamps each line.

This is **acknowledged debt**, tracked in [issue #146](https://github.com/hongyilyu/inkstone/issues/146): identity travels on a second, unvalidated channel separate from the structured manifest the Worker already parses, and an unset var silently yields empty `run_id` — the exact correlation the trail exists to provide. The long-term fix is to add `run_id` to `WorkerManifest` (in-band, schema-validated, and it lets `transport-stdio.ts` stop hardcoding `""`). That is a `packages/protocol` contract change, deliberately deferred so Logging v1 ships without a protocol delta. Env-at-spawn is the surgical short-term seam; the manifest field is the destination.

## Redaction: quiet `sqlx`, preserve the Worker's existing scrub, no central layer

Two leak paths, two narrow mitigations — no general-purpose redaction layer:

- **`sqlx` query logging is clamped to `WARN`** in the default `EnvFilter` (`sqlx::query=warn`), so SQL statements and their bound parameters are **not** written to disk at the `INFO` default. (Set `INKSTONE_LOG=debug` to opt into query traces when diagnosing.)
- **The Worker keeps its OAuth-token scrub.** `provider.ts` deliberately discards the underlying SDK error and emits only a generic message at the refresh/helper failure sites (the comments there cite token-leak risk; [ADR-0023](./0023-provider-oauth-core-owned-credentials.md) makes Core the sole credential owner). Any `worker.jsonl` write at those sites logs only the generic event key, **never** the caught error object.

A central field-scrubbing `tracing` layer (allowlist/denylist of field names) was rejected as premature: real complexity and a perf cost for a pre-release, single-user, local-first app ([ADR-0007](./0007-local-first-single-user.md)) where the two known leak paths are individually closeable. Re-evaluate if a field-redaction need recurs.

## Instrument-only: make swallows observable, do not change control flow

This is the policy for *what gets logged*, recorded so a later reader does not mistake the scope. Every silent swallow the survey found — `let _ = tx.send(...)` on broadcast sends, empty `.catch(() => {})` in the Worker, dropped malformed inbound frames, best-effort failures logged-then-forgotten — becomes an observable `WARN`/`ERROR` with a stable `event` and context fields. **No control flow changes**: no new retries, no propagation changes, no error-type redesign. The trail then tells us *which* swallows actually fire in practice, and root-cause fixes come in a separate data-driven pass. This honors the surgical-changes principle (§3): a logging task that also rewires error handling is two tasks, and the second should be driven by the first's data.

Level assignment is coarse and consistent: `ERROR` for a fault that lost data or failed an operation the caller expected to succeed; `WARN` for a tolerated degradation (broadcast lag re-snapshot, a best-effort projection that will be rebuilt); `INFO` for lifecycle milestones (boot, listening). A broadcast `send` returning `Err` only because there are zero subscribers — normal teardown — stays an intentional drop and is **not** promoted to a log; promoting it would be noise, not signal.

## Consequences

- `crates/core/Cargo.toml` gains `tracing`, `tracing-subscriber` (with `env-filter`, `json`), and `tracing-appender`. A subscriber is initialized as the first statement of `main()`, before `workflow::init`, so even early fail-fast paths are captured. The init is **fail-open**: if the sink can't be built (e.g. an unwritable log dir) Core logs `INKSTONE_LOG_INIT_FAILED` to stderr and boots anyway — observability is not an availability dependency.
- The ~31 `eprintln!`/`println!` diagnostic sites across `main.rs`, `runs/handler.rs` (the [ADR-0029](./0029-request-handler-seam.md) `Internal` logging site), `runs/subscribe.rs`, `db/lifecycle.rs`, and `worker/{child,run,mod}.rs` become `tracing` events with stable `event` keys. The three `INKSTONE_*` stdout markers are **not** among them — they stay as raw `println!`.
- The Worker gains a `worker.jsonl` sink modeled on `tool-proxy.ts`'s `INKSTONE_WORKER_TOOL_CALL_LOG` `appendFileSync` pattern (with a `try/catch` the existing one lacks), reads `INKSTONE_RUN_ID`, and instruments its swallow sites — preserving the `provider.ts` scrub. The sink keys off `INKSTONE_WORKER_LOG_PATH`, which Core supplies by default at spawn (`<log-dir>/worker.jsonl`), so the trail is on by default; an operator-set value overrides it.
- A new tier-3-like artifact exists on disk under `<data-dir>/inkstone/logs/`. It is rotatable and deletable with no product impact; retention is bounded by `max_log_files`.
- **Acknowledged gaps, not fixed here:** (1) a hard Worker crash *before* it can write JSON (uncaught top-level throw) still goes to inherited stderr and vanishes — the cost of the simplest seam, since `child.rs` keeps `Stdio::inherit()`; (2) `run_id` correlation depends on the env var being set (issue #146); (3) the Web Client emits nothing — client-side capture is out of scope for v1.
- Reversal cost is low: remove the subscriber init and the appenders, and the `tracing` events become no-ops (or revert to `eprintln!`). The `event`-key discipline is the load-bearing convention; the file sink is swappable.

## Considered and rejected

- **`log` + `env_logger`.** No spans (so `run_id` correlation must be hand-threaded into every message — the gap this ADR closes), no structured fields (so the message is prose and `GROUP BY event` degrades to fuzzy matching), and no capture of the `sqlx`/`tokio` events already flowing through `tracing`. Rejected: weaker on exactly the axes the hardening loop needs.
- **Hand-rolled macro writing rows to a SQLite `logs` table.** Gives SQL aggregation, but reimplements levels/filtering/span-propagation/formatting, couples the trail to the DB this project resets freely (§5), and bloats the authoritative store with non-authoritative data. Rejected: cost out of proportion to "nicer queries" for one consumer that `jq` already serves.
- **JSONL on stdout, captured by the launcher.** Interleaves with the `INKSTONE_*` liveness markers the harness parses and invites coupling between a high-volume diagnostic stream and the boot protocol. Rejected for the decoupled file.
- **A pretty human-readable stderr layer in v1.** Useful for live `pnpm dev` watching, but the chosen consumer is an agent reading a file; adding it now is scope the request did not ask for. Trivial to add later as a second layer. Deferred, not refused.
- **`run_id` in `WorkerManifest` now (in-band).** The correct end state, but a `packages/protocol` contract change rippling protocol→core→worker for a field the Worker uses only to label log lines. Rejected *for v1* to keep the feature contract-free; tracked as the destination in issue #146.
- **A central field-redaction `tracing` layer.** Premature for a pre-release single-user local app with two individually-closeable leak paths. Rejected now; revisit on recurrence.
- **Fixing the swallows (retries/propagation) in this task.** Conflates instrumentation with an error-handling redesign — two tasks. Rejected: instrument first, let the trail's data drive the fixes (§3 surgical changes).

## Related

- [ADR-0028](./0028-run-status-materialized-transitions.md) — the **Run Log** (durable tier-2 milestones) this ADR's Diagnostic Log is explicitly *not*; their vocabularies are kept disjoint.
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md), [ADR-0006](./0006-run-events-vs-tool-protocol.md) — the **Run Event** wire stream, the third concept in the disambiguation; logs never ride the wire.
- [ADR-0029](./0029-request-handler-seam.md) — the centralized `Internal`-error logging site (`runs/handler.rs`) that this ADR converts from `eprintln!` to a structured `tracing` event, preserving its single-framing-site discipline.
- [ADR-0023](./0023-provider-oauth-core-owned-credentials.md) — Core-owned credentials and the Worker's token scrub the redaction policy preserves.
- [ADR-0013](./0013-worker-process-lifecycle-and-transport.md) — the Worker child-process lifecycle (`child.rs`, `Stdio::inherit()`) whose seam constrains how `run_id` reaches the Worker and why hard crashes can still escape capture.
- [ADR-0007](./0007-local-first-single-user.md) — local-first, single-user posture that makes a local file sink and deferred central redaction the proportionate choices.
- [ADR-0026](./0026-worker-transport-seam.md) — the "indirection without leverage" stance behind rejecting a hand-rolled logger and a central redaction layer in favor of the standard `tracing` substrate.
- [issue #146](https://github.com/hongyilyu/inkstone/issues/146) — moving `run_id` from the spawn env var into `WorkerManifest` (in-band), the destination for the seam this ADR ships out-of-band.
