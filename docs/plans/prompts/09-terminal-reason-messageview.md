# Carry runs.terminal_reason on MessageView so cancelled turns rehydrate as "stopped"

## Context

Read AGENTS.md (working principles + CI gate) and CONTEXT.md (vocabulary: Run, Run status, Message) first.

THE GAP. A user who clicks Stop on a streaming reply sees the calm "You stopped this reply" notice (SettledNotice, tone="stopped", role="status", data-testid="assistant-stopped" — apps/web/src/components/ChatColumn.tsx:672-690, component defined :702-742). That state is LIVE-ONLY: the store flag `Message.cancelled` is set by the `cancelled` Run Event arm in `applyEvent` (apps/web/src/store/chat.ts:888-899) and nowhere else. On reload, `thread/get` rehydration (apps/web/src/store/hydrate.ts `toMessage`, line 75) never sets `cancelled` because the wire `MessageView` carries only `{id, role, status, run_id, segments}` — `messages.status` is a bare `incomplete` for BOTH cancel and worker error (Core's cancel verbs run `mark_streaming_messages_incomplete`, crates/core/src/db/lifecycle.rs:240 and :266). So a cancelled turn reloads as the red role="alert" FAILURE bubble (ChatColumn.tsx:681-690 fallback branch). Worse, its "Try again" routes to `retryErroredRun` → `run/retry`, which is guarded on `status = 'errored'` (crates/core/src/runs/retry.rs; lifecycle.rs `RunStatus::retry` ~:194-218) and returns `not_errored` for a cancelled Run — a dead button. The live path already special-cases this: ChatColumn.tsx:301-317 routes `message.cancelled || message.run_id === ""` to `resend` (a fresh `run/send` of the prior user prompt, ChatColumn.tsx:230-248) — but rehydrated messages never have `cancelled` set, so they take the dead run/retry path.

THE DURABLE TRUTH ALREADY EXISTS. `runs.terminal_reason` (crates/core/migrations/0001_initial.sql:24-25, CHECK in ('completed','cancelled','worker_disconnected','core_restarted','errored')) is stamped `'cancelled'` by both cancel verbs via `TerminalReason::Cancelled.as_str()` (crates/core/src/db/lifecycle.rs:231 for parked, :257 for running; queries `mark_parked_run_cancelled` at crates/core/src/db/queries.rs:2169-2188 and `mark_running_run_cancelled` at :251-270). The enum lives at lifecycle.rs:28-53. Nothing reads it into `thread/get` today.

THE READ PATH (all verified). `queries::messages_by_thread` (crates/core/src/db/queries.rs:2322-2336) returns `(id, role, status, run_id)` 4-tuples from `messages` only — no runs JOIN. Its sole caller is `db::get_thread_with_messages` (crates/core/src/db/mod.rs:722-758), which builds `MessageRow` (struct at db/mod.rs:694-700: id/role/status/run_id/segments; destructuring loop at :732, constructed at :748). The `thread/get` handler (crates/core/src/runs/thread_get.rs:29-63) maps `MessageRow` → wire `MessageView` (crates/core/src/protocol.rs:818-824, doc block :810-816). The TS mirror is `MessageView` in packages/protocol/src/index.ts:314-325 (Effect Schema `S.Struct`; the sibling `Segment` union at :284-312 shows the `S.optional(S.String)` convention, e.g. `entity_id` at :301). The Rust `Segment::Proposal.entity_id` (protocol.rs:791-797) shows the matching `#[serde(skip_serializing_if = "Option::is_none")]` convention with the "omitted (not `null`, matching the TS `S.optional`)" doc phrasing.

CONTRACT GATE. tests/contract enforces Rust↔TS wire parity via committed fixtures: the `fx!` blocks in `mod parity_fixtures` (crates/core/src/protocol.rs:2070+; thread_get maximal fixture at :2607-2647, bare at :2649-2664) serialize through real serde into tests/contract/fixtures/structs/emitted/thread_get_result.json + thread_get_result.bare.json. `cargo test regenerate_struct_fixtures` (protocol.rs:2909) rewrites them; `emitted_fixtures_match_committed` (protocol.rs:2927, include_str!-locked, lists both files at :2975-2976) bites on staleness. The TS side (tests/contract/src/structs.test.ts) decodes each fixture with `onExcessProperty: "error"` against the schema registered in tests/contract/src/structs.registry.ts (ThreadGetResult entries at :568-579) — so adding a field to the fixture without the TS schema turns CI red, and vice versa.

STALE COMMENT. apps/web/src/store/chat.ts:52-63 documents `Message.cancelled` as "Live-only … a turn cancelled in a PRIOR session rehydrates with `cancelled` unset … Distinguishing them across reload would need a contract change (a terminal-reason on the wire); out of scope here." This feature IS that contract change; the comment must be rewritten.

MessageRow's other consumer, the `read_thread` tool (crates/core/src/tools/read_thread.rs:65), reads only `m.role` and `m.text()` — unaffected. `run/get_history` and the RunFeed's "Cancelled" label (apps/web/src/lib/runHistory.ts:38) are a separate surface — untouched.

No ADR is needed: this is an additive-optional field on an existing read, squarely inside ADR-0043/0044/0045's rehydration-parity line and ADR-0014's cancel-is-not-an-error stance (the exact phrase code comments cite, e.g. tests/e2e/src/page-objects/ChatPage.ts:44-45).

## Goal

Thread the Run's `terminal_reason` from the `runs` table onto each `thread/get` MessageView as an additive-optional field on both sides of the contract (Rust serde + Effect Schema + regenerated fixtures), then use it in apps/web hydration to set the existing `Message.cancelled` store flag when an `incomplete` assistant turn belongs to a `terminal_reason='cancelled'` Run — so a cancelled turn reloads with the same calm "stopped" SettledNotice the live session showed, and its "Try again" takes the already-wired resend path instead of the dead run/retry. No schema migration, no new verbs, no UI component changes: the boundary is one SQL JOIN, one field on four type definitions (MessageRow, Rust MessageView, TS MessageView, fixtures), one hydration mapping, one comment rewrite, and tests.

## End state

- crates/core/src/db/queries.rs `messages_by_thread`: SELECT joins runs (`JOIN runs r ON r.id = m.run_id`), returns 5-tuples `(String, String, String, String, Option<String>)` with `r.terminal_reason` last; doc comment (:2318-2321) updated.
- crates/core/src/db/mod.rs `MessageRow` gains `pub terminal_reason: Option<String>`; `get_thread_with_messages` destructures the 5-tuple and populates it.
- crates/core/src/protocol.rs `MessageView` gains `#[serde(skip_serializing_if = "Option::is_none")] pub terminal_reason: Option<String>` with a doc line ("the owning Run's terminal_reason — 'cancelled' lets the Client rehydrate a stopped turn calmly; omitted (not null, matching the TS S.optional) while the Run is live").
- crates/core/src/runs/thread_get.rs maps `terminal_reason: row.terminal_reason` into MessageView.
- protocol.rs fx! maximal `thread_get_result.json` MessageView populates `terminal_reason: Some("completed".to_string())` (coherent with its existing `status: "complete"` spelling); the bare fixture leaves it `None` (a user turn of a still-live Run) — covering both branches. `tests/contract/fixtures/structs/emitted/thread_get_result.json` regenerated and committed (bare file byte-identical).
- packages/protocol/src/index.ts `MessageView` gains `terminal_reason: S.optional(S.String)` with a matching doc comment.
- apps/web/src/store/hydrate.ts `toMessage` sets `cancelled: true` on the returned Message iff `status === "incomplete"` (the post-narrowing local) and `view.terminal_reason === "cancelled"`; leaves the property absent otherwise.
- apps/web/src/store/chat.ts:52-63 comment rewritten: `cancelled` is set live by the `cancelled` Run Event AND on rehydration from `MessageView.terminal_reason === 'cancelled'` — the "Live-only / out of scope" paragraph deleted.
- Behavior: cancel a streaming run, reload → `[data-testid="assistant-stopped"]` renders (no `assistant-error` in the DOM); its Try again resends the prior prompt (ChatColumn's existing `message.cancelled` routing — zero ChatColumn changes).
- All CI gates green: pnpm format / lint / check, pnpm -r test (web + protocol + contract vitest), cargo test --manifest-path crates/core/Cargo.toml, and the extended e2e spec passes.

## Desired outcome

A user who stops a reply, closes the tab, and comes back sees the same calm muted "You stopped this reply. Nothing was saved without your approval." notice they saw live — not a red screaming failure alert for something they deliberately did. And "Try again" on that reloaded turn actually works: it re-sends the prior prompt as a fresh Run instead of silently hitting run/retry's not_errored dead end. This closes the last live-vs-reload rendering divergence for cancelled turns, keeping Inkstone's promise that a Thread rehydrates exactly as it was.

## Implementation notes

Work Core-out, contract, then web. Every message row's `run_id` is NOT NULL REFERENCES runs(id) (0001_initial.sql:38), so the JOIN never drops rows.

1. crates/core/src/db/queries.rs:2322 `messages_by_thread` — change SQL to `SELECT m.id, m.role, m.status, m.run_id, r.terminal_reason FROM messages m JOIN runs r ON r.id = m.run_id WHERE m.thread_id = ?1 ORDER BY m.created_at, m.rowid` and widen the return type to `Vec<(String, String, String, String, Option<String>)>`. Keep the rowid-tiebreaker comment; note user rows of a settled Run will carry the reason too (harmless — user Messages insert as `completed` (db/mod.rs:1007-1016), and the client keys on `incomplete`).

2. crates/core/src/db/mod.rs — add `pub terminal_reason: Option<String>` to `MessageRow` (:694) and update the loop at :732/:748 (`for (id, role, status, run_id, terminal_reason) in rows` … push it). The `read_thread` tool and existing db tests compile unchanged (they read role/segments/text(); nothing else constructs `MessageRow`).

3. crates/core/src/protocol.rs:818 `MessageView` — add the optional field copying the `Segment::Proposal.entity_id` pattern (:791-797): `#[serde(skip_serializing_if = "Option::is_none")]`. Update the struct's doc block (:810-816) with one sentence.

4. crates/core/src/runs/thread_get.rs:31 — add `terminal_reason: row.terminal_reason,` to the MessageView literal. Compile error if you forget — the struct derives only Debug/Serialize, no `..Default`.

5. Fixtures: in protocol.rs `mod parity_fixtures`, add `terminal_reason: Some("completed".to_string())` to the maximal MessageView (:2612) and `terminal_reason: None` to the bare one (:2654). Run `cargo test --manifest-path crates/core/Cargo.toml regenerate_struct_fixtures`, then `cargo test --manifest-path crates/core/Cargo.toml emitted_fixtures_match_committed` to confirm, and commit tests/contract/fixtures/structs/emitted/thread_get_result.json. LANDMINE: skipping the fx! population leaves the fixture unchanged and the new field silently uncovered by the parity gate; populating it but forgetting to regenerate makes `emitted_fixtures_match_committed` fail with a "stale fixture" message naming the file.

6. packages/protocol/src/index.ts:314 — add `terminal_reason: S.optional(S.String),` to the MessageView S.Struct, doc-commented like `entity_id` (:297-301). LANDMINE: tests/contract/src/structs.test.ts decodes fixtures with `onExcessProperty: "error"` — the regenerated maximal fixture fails TS decode until this lands. No structs.registry.ts changes needed (ThreadGetResult already registered at :568-579, and it is a struct, not a union — no UNION_VARIANTS bump).

7. apps/web/src/store/hydrate.ts:75 `toMessage` — after the existing `status` narrowing, compute `const cancelled = status === "incomplete" && view.terminal_reason === "cancelled";` and return `{ id, role, status, run_id, segments, ...(cancelled ? { cancelled: true } : {}) }` (Message.cancelled is `readonly cancelled?: boolean`; spread keeps it absent rather than `false`, matching how `applyEvent` leaves non-cancelled turns). Do NOT set `cancelled` for `terminal_reason === "errored"|"worker_disconnected"|"core_restarted"` — those keep the failure alert. Update the `toMessage` doc comment.

8. apps/web/src/store/chat.ts:52-63 — rewrite the `cancelled` doc: set live by the `cancelled` Run Event (applyEvent) and on rehydration from the wire `MessageView.terminal_reason === 'cancelled'` (hydrate.ts toMessage); drop the "Live-only … out of scope" sentences. Also glance at resetMessageForRetry's doc (:460-473) — it already clears `cancelled`; no code change.

9. NO ChatColumn.tsx change: the routing at :301-317 (`message.cancelled || message.run_id === ""` → resend via prior user turn's concatText; else retryErroredRun) and the SettledNotice branch at :672-690 already key on `message.cancelled`. The rehydrated history includes the prior user Message, so the `messages[i - 1]?.role === "user"` guard holds and Try again is offered.

Landmines recap: (a) the wire spells omission, not null — Rust `skip_serializing_if` + TS `S.optional`, never `S.NullOr`; (b) apps/web hydrate tests construct `ThreadGetResult` literals — optional field means no churn in existing cases; (c) `pnpm check` runs tsc across the workspace + cargo check, catching a missed side; (d) grep for other `MessageView {` literals — only protocol.rs fixtures (:2612, :2654) and thread_get.rs:31 construct it (verified); (e) migrations need NO edit — 0001_initial.sql:24-25 already has the CHECK.

Commit as one change: `feat(core,web): carry runs.terminal_reason on MessageView so cancelled turns rehydrate stopped` (matches the ede48c2 `feat(core,web)` precedent).

## Testing approach

Four layers, all extending existing harnesses:

1. Cargo unit (crates/core/src/db/mod.rs `mod tests`): add `thread_get_carries_cancelled_terminal_reason` next to `thread_get_assembles_ordered_segments_excluding_proposals` (:3290). Copy its seeding shape — `memory_pool()`, `queries::insert_thread`, raw `INSERT INTO runs (...)` (extend that test's column list `(id, thread_id, workflow_name, workflow_version, provider, model, thinking_level, user_message_id, status, started_at)` with `terminal_reason` and `ended_at`; seed `status='cancelled', terminal_reason='cancelled'`), `queries::insert_message` with role "assistant" status "incomplete" — then assert `get_thread_with_messages` yields `terminal_reason == Some("cancelled".to_string())` on the assistant row and `None` for a run left `running`. (The intent_graph seed at crates/core/src/db/intent_graph.rs:2201 shows an INSERT already listing terminal_reason.)

2. Contract gate (tests/contract): no new test code — populate the fx! instances, run `cargo test --manifest-path crates/core/Cargo.toml regenerate_struct_fixtures`, commit the emitted JSON, then `pnpm -C tests/contract test` (structs.test.ts round-trips the fixture through the TS schema with onExcessProperty:"error"; structs.completeness.test.ts is satisfied since no fixture file is added or removed).

3. Web vitest (apps/web/test/store/hydrate.test.tsx): add a case following the "rehydrates a reasoning segment" pattern (:152-189) — `stubWsClient` with `threadGet` returning an `incomplete` assistant MessageView with `terminal_reason: "cancelled"`, `hydrateThread`, assert the stored message has `cancelled === true`; companion assertions that `terminal_reason: "errored"` and an absent field leave `cancelled` undefined (the failure-alert path). Run `pnpm -C apps/web test` or `pnpm -r test`.

4. E2E (tests/e2e/src/run-cancel-ui.spec.ts): extend the existing "clicking Stop cancels a streaming run and settles the bubble" spec — after the current final assertions, `await chat.reload();` (ChatPage.reload() at page-objects/ChatPage.ts:138; ADR-0061: the /thread/<id> URL survives reload and rehydrates, per the decided-proposal-reload.spec.ts:60 precedent — no openThread needed), then assert `await expect(chat.assistantStopped()).toBeVisible({ timeout: 15_000 })`, `await expect(chat.assistantStopped()).toContainText("You stopped this reply")`, `await expect(chat.assistantError()).toHaveCount(0)`, and the notice's Try again button is visible (`chat.assistantStopped().getByRole("button", { name: /try again/i })`). The spec already uses the gated 2-chunk fixture (`test.use({ coreOptions: { chunks: 2 } })` at :7) so the Run is genuinely cancelled mid-stream. Run `pnpm -C tests/e2e exec playwright test src/run-cancel-ui.spec.ts` (or `pnpm test:e2e` for the suite; globalSetup builds core + web dist).

CI gate before done (AGENTS.md §6): `pnpm format`, `pnpm lint`, `pnpm check`, `pnpm -r test`, `cargo test --manifest-path crates/core/Cargo.toml`. Confirm `git diff -w` shows only task-traceable edits.

## Out of scope

- No `terminal_reason` on run/subscribe, run/get_history, or any verb other than thread/get (the RunFeed already renders Cancelled from Run Log milestones).
- No error_code/error_message on MessageView, and no rehydration of the worker error MESSAGE text — an errored turn reloads exactly as today (generic failure copy).
- No typed enum on the wire: the field is a plain optional string on both sides (matching `status`'s open-string precedent in MessageView); do not add a TerminalReason wire union or S.Literal set.
- No ChatColumn/SettledNotice/UI component changes, no new store actions — only the hydrate mapping and the comment rewrite touch apps/web.
- No migration edits (the column and CHECK already exist), no run/retry changes (cancelled stays not_errored by design — resend is the recovery), no new ADR.
- Do not "fix" the stale "cover all three Segment variants" comment in structs.registry.ts:565-567 (there are four variants since reasoning landed) or other adjacent docs — mention-only if noticed (AGENTS §3 surgical changes).
- Do not backfill the ui-sdk threadGet round-trip test (packages/ui-sdk/test/index.test.ts:448) with the new field — optional means it passes untouched.
