# TickTick Writes — task capture returns, through the Proposal gate

Date: 2026-08-19 · rev 6 · Status: CONVERGED — design settled over five
premortem revisions (22 review threads, all resolved); **W1, the
write-contract spike, ran 2026-08-19 — verdict GO** (every gate item matched
the plan's assumption; findings in the ledger's "Resolved by W1" section)

THIS file (`docs/plans/`) is the converged copy of record. The review trail is
`premortem.hongy.io/p/inkstone/ticktick-writes@1`–`@7` — each immutable @N
embeds the then-current full plan text as an appendix, so the design history
stays auditable independent of any working copy. A future revision edits this
file and republishes as @8+ under the same embedded-appendix contract.

Reopens, deliberately, the capability ADR-0064 removed: *"Until a future write
feature, Inkstone cannot create or edit a task."* This is that feature. The
headline is un-deleting the redirect in `crates/core/workflows/default.toml` —
"remind me to buy milk" stops being "add it in TickTick yourself" and becomes a
reviewable create-task Proposal that, on accept, lands in TickTick.

Source naming, used throughout: **read-plan A*n*** = the committed
`docs/plans/external-task-views-plan.md` assumptions (e.g. read-plan A7 = the
boot-resolved request-timeout knob); **mcp-A14** = assumption A14 of the
*abandoned* MCP-connectors write design (rev 2, 2026-08-11), whose surviving
artifact is `.agents/runs/mcp-integration-2026-08-10/mcp-connectors-plan.html`:
*"Unknown never re-fires — crash between approve and record settles the action
as unknown; no auto-retry without an idempotency contract."* ADR-0065 restates
that sentence so the invariant is not anchored to a mostly-lost artifact.

## Decision ledger (read first)

**Agreed** (user-directed, settled 2026-08-19):

- **Agent write verbs: `create` only.** No agent-proposed complete / update /
  delete in v1. Each would be its own family arm, spike surface, and card;
  complete is a named fast-follow candidate, not scope.
- **User-direct writes: deferred entirely.** The Tasks Topic stays read-only
  with the "open TickTick" escape hatch. User-direct complete/uncomplete is its
  own later feature with its own spike (uncomplete's existence in the OpenAPI is
  unproven).
- **Auto-approve: hard-barred for TickTick writes.** Every write is a manual
  Decision. External writes are excluded from any future auto-approve policy
  until TickTick offers an idempotency contract; reopening this requires
  amending the ADR, not flipping a manifest flag (mcp-A14 lineage).
- **Card edit: yes.** Editable title, due (+ all-day toggle), note before
  accept. Rides the existing `edited_payload` mechanism; `supports_edit` = true.
- **Inherited and still binding** (read-plan ledger): TickTick is the sole task
  authority; Core holds no task state, no task cache, no sync engine; no
  generic provider abstraction; TickTick-concrete naming; both shipped read
  lanes unchanged.
- **A failed write is a failed write.** No local queue, no retry daemon, no
  deferred delivery.
- **Two-phase accept** (premortem lesson a): a remote write never runs inside
  decide's atomic accept transaction. Approve+commit → call outside any tx →
  record outcome; outcomes are three-valued `created | failed | unknown`;
  `unknown` never auto-refires (mcp-A14, restated above).
- **The parked Proposal IS the tool call** (premortem lesson b): the model's
  propose call itself parks as the Proposal — no wrapper proposal tool around a
  would-be direct write tool, no second write path.
- **Writes ship dark, cut over deliberately.** The exposure lever is the
  default Workflow's `tools` list + prompt rewrite (mirrors the read path's
  `external_tools = true` lever). Read invariants must not regress; read-lane
  tests keep passing unchanged.

**Proposed** (this plan's recommendations — reviewable, not user-approved):

- **W-A1: the write lane is Core-executed OpenAPI on Proposal accept.** The
  Worker MCP allowlist is untouched; MCP write tools stay permanently out of
  the Worker lane (the argued case is W-A1 below).
- **W-A2: a new dedicated proposal tool `propose_ticktick_task`** (a second
  `Dispatch::Proposal` registry entry), NOT a 13th `ProposableMutation` kind.
  Stored `mutation_kind`: `create_ticktick_task`, derived from the TOOL NAME at
  park (the tool's params carry no `mutation_kind` field — see W-A2 mechanics).
- **v1 payload is `{title, note?, due?}` — no projectId, no tags, no
  priority.** Every agent create lands in **Inbox** (capture → Inbox → the user
  organizes in TickTick is the GTD-honest flow). W1 gated it and confirmed:
  create-without-projectId lands in Inbox.
- **W-A3: the write is a first-class state machine** —
  `proposed → executing → settled(created|failed|unknown)` in a
  `ticktick_writes` row created at PARK (with a credential-fingerprint
  snapshot), driven through ONE guarded settle path whose exactly three
  triggers are phase C, the boot sweep, and the detached deadline watchdog
  spawned at phase A commit. Replay/recovery during `executing` answers
  "executing" and never resumes, never re-POSTs; reads never settle.
- **Credential-fingerprint guard:** the park-time snapshot is an INTERNAL hash
  of the access token (`credential_fp` — a `ticktick_writes` column, never on
  the wire or in logs; A5's never-token-derived rule protects wire-visible ids
  and query keys, not a local comparison). Phase A re-checks current == snapshot:
  the SAME credential matches across any number of restarts — the overnight
  propose-at-night / accept-in-the-morning flow works — while a real credential
  change (account swap; also a ~180-day reprovision, accepted as a rare honest
  refusal) refuses with a typed error and no POST. A boot-scoped connection-ID
  snapshot would NOT work here: the id is random per boot by design, so every
  restart would permanently strand every parked write Proposal.
- **Staleness is DERIVED at read, enforced at decide.** The fingerprint
  comparison is computable by any reader (the row's snapshot vs the current
  boot connection's fingerprint — both durable/boot-stable), so the pending
  card's read shape carries `{state:"proposed", stale_connection}` and a stale
  card renders its warning ON FIRST RENDER — after a reload, in a second tab,
  before any doomed attempt — with accept disabled and reject enabled. The
  dedicated typed decide error (`stale_connection`, its own code — never
  folded into `proposal_not_pending`) remains the phase-A ENFORCEMENT for the
  race where a tab still shows a pre-restart card. Disabled-accept is not
  connection-local state; it is re-derived by every read.
- **Decide is DETACHED from the socket loop:** Core's per-connection loop
  awaits each dispatch inline and owns outbound sends in the same `select!`,
  so a decide that blocked A→C would freeze the connection both directions for
  up to the A7 timeout — no queued frames out (other Runs' tails stall), no
  further requests in (a same-socket Stop could never reach `write_in_flight`;
  it would land after resume and kill the fresh Worker mid-narration). The
  write-family decide handler therefore runs as its own task, replying by
  request id on `out_tx`; the RESPONSE still carries the outcome (the caller's
  contract is unchanged — it just no longer holds the socket hostage). The
  latent same-shape inline blocking of `ticktick/tasks/list` is a named
  pre-existing issue, out of this feature's scope.
- **Cross-tab scope, honestly:** `proposal/changed` reaches the DECIDING
  connection only (there is no broadcast bus — ADR-0025 as-built, verified in
  `runs/reply.rs`). The deciding tab renders from its own decide response; any
  other tab converges on its next `thread/get`. Multi-tab live Proposal sync
  stays explicitly deferred; this plan does not claim it.
- **Outcome classification is an exhaustive match, not a boolean** (table
  below; confirmed by W1 as designed): an exhaustive match over (status,
  transport-predicate) whose DEFAULT arm is `unknown` — a novel transport error
  can never classify `failed`. `failed` ⊆ deterministic 4xx ∪ pre-send connect
  failure (reqwest `is_connect` only — nothing was sent); `created` requires a
  decoded body WITH a non-empty task id; everything ambiguous — 5xx, 408,
  timeouts, mid-flight cuts, undecodable or id-less 2xx — is `unknown`.
- **Settlement has an owner, and the owner survives the worker it watches:**
  phase A's commit arms a deadline watchdog for the proposal (fires at
  `requested_at` + A7 timeout + grace, runs the guarded settle — a no-op if
  already settled). The watchdog is its OWN spawned task, keyed by the write
  row — never a timeout combinator inside the decide task, whose panic or
  abort would silently kill the deadline with it (detached-task panics vanish
  once the JoinHandle drops) and reintroduce restart-dependence. Belt: a
  past-bound decide replay may also settle. Reads never settle server-side.
- **A reloaded "executing" card drives itself to the outcome:** an `executing`
  state entered from hydration or replay (not the caller's own in-flight
  decide) starts a BOUNDED `thread/get` poll, capped by the variant's
  Core-supplied **`deadline_at`** (the client has neither `requested_at` nor
  the A7 knob, so it never computes the bound itself); the watchdog
  guarantees the server settles by then, so the card reaches the recorded
  outcome with no user action after an F5 or reconnect mid-write. If the
  deadline passes and the read still says executing (watchdog residue), the
  card renders an honest "still unresolved" with a **Resolve now** re-decide
  (a write — the past-bound belt) instead of an eternal creating….
- **The EDITED payload is Core-validated for this family too** (ADR-0025
  doctrine), through the same validator as pre-park, on the FRESH apply path
  only — positioned after the replay/recovery branches so a malformed edit
  retry of an in-flight decide answers "executing", never `invalid_params`.
- **One durable outcome shape** carried everywhere the Client can look:
  the decide response, `proposal/changed`, and `Segment.proposal` (a new
  optional `ticktick_write` union) — live and reload render identically for all
  four states (`executing | created | failed | unknown`).
- **Cancel is a state matrix, not one rule:** `proposed` (proposal pending) →
  the existing parked-cancel path (cancel proposal + run); `executing` →
  refused with a new `write_in_flight` outcome, the Web keeps the card and
  keeps observing; `settled` + Run still parked (the phase-C-commit → resume
  window) → parked-cancel gains an accepted+settled arm doing a REAL
  `parked → cancelled` CAS that races resume's `parked → running` — cancel
  wins: no spawn, the recorded outcome stays readable; resume wins: the cancel
  re-routes through the running path. The Web settles only on Core's actual
  answer — today's `already_terminal`-on-parked local settle can no longer
  render "stopped" over a Run the settle path is about to resume.
- **Scope is parsed at boot:** the token file's optional `scope` field, when
  present and missing `tasks:write`, marks the connection non-writable and the
  pre-park check rejects proposing — a scope-short token fails before review,
  not after accept. Absent `scope` = writable (provisioning convention, stated).
- Not-connected behavior: the same pre-park check rejects with a normal tool
  error ("TickTick is not connected") — the model redirects the user to
  provisioning; no park, no dead card.
- Model-facing Decision results are `is_error: false` in all three outcomes —
  the Decision resolved; the outcome is content the model must relay (exact
  texts in W-A3).
- The demo proofs (below).

**Resolved by W1 — the spike ran 2026-08-19 against the disposable smoke
account (`scripts/ticktick-write-spike.mjs`, manual dispatch, non-capturing,
self-cleaning: 10 staged rows created, 10 deleted, 0 leaked). Verdict: GO on
every gate item:**

- **Create happy path: GO.** `POST /open/v1/task {"title"}` → **200** (not
  201) with a decodable body that is the created task: non-empty `id`,
  `projectId`, plus `title/status/kind/priority/tags/isAllDay/timeZone/
  sortOrder/etag/createdTime/modifiedTime` (+ `dueDate`/`startDate` when a due
  was sent, + the note field when sent).
- **Duplicate double-POST: two tasks, distinct ids** — both visible in the
  filter read. Create is NOT idempotent; never-auto-refire is load-bearing,
  confirmed.
- **Create WITHOUT `projectId` → Inbox: GO.** The create response's
  `projectId` is `inbox`-prefixed and the filter read-back shows the same
  `^inbox` sentinel row. The Inbox-only v1 payload stands.
- **Due tuple: GO, byte-exact round-trip.** All-day
  (`dueDate:"2026-09-01T07:00:00.000+0000", isAllDay:true, timeZone:
  "America/Los_Angeles"`) and timed (`…17:30:00.000+0000, isAllDay:false`)
  both came back through the filter read with `dueDate`/`isAllDay`/`timeZone`
  equal to what was sent; the server sets `startDate == dueDate` (the S1a
  collapse confirmed from the write side — one due tuple, no start field).
  **Format addendum (probed):** `dueDate` accepts `Z`, `±HHMM`, and `±HH:MM`
  offsets, all normalized to the instant; a NAIVE datetime (no offset) is
  parsed as UTC — `timeZone` is display-only, never consulted at parse. A
  naive local wall time would therefore silently land at the wrong instant,
  so the v1 due validation REQUIRES an offset-bearing datetime
  (`YYYY-MM-DDTHH:MM:SS(.mmm)?(Z|±HH:MM|±HHMM)`); UI-created all-day tasks
  carry local-midnight-in-zone as the instant (07:00Z for LA), which the
  card's edit form reproduces browser-side.
- **Note field: `content`.** A `content` create round-trips as `content`; a
  `desc` create round-trips as `desc` and does NOT surface as `content`
  (`desc` is the checklist-description field). v1 maps note → `content`.
- **The classification table, as observed** (the W-A3 table is CONFIRMED as
  designed; one upstream surprise recorded):
  - 401 (bad bearer) → 401 with a decodable OAuth envelope
    (`error/error_description/errors`). `failed`, per the 4xx family. ✓
  - **TickTick answers deterministic VALIDATION rejections as 500**, with a
    decodable `{data, errorCode, errorId, errorMessage}` envelope: empty
    payload, empty/whitespace title, a 1 MiB title, and — notably — a
    **scope-short (`tasks:read`) token** all came back 500, nothing created.
    Under the table these classify `unknown` (a 500 is indistinguishable from
    a transient gateway fault), which is the accepted-conservative outcome;
    Core's pre-park validation (trimmed non-empty title, well-formed due,
    boot-parsed scope) keeps every *predictable* member of this class from
    ever reaching phase B. No 4xx-shaped validation rejection was observed.
  - **A 2xx with an UNDECODABLE body exists in the wild** (a GET probe of a
    bogus task id answered 200 with a non-JSON body) → `created`-requires-a-
    decoded-non-empty-id is load-bearing, confirmed. No DECODABLE 2xx error
    envelope was observed (the STOP condition did not fire); the classifier
    defends against both shapes regardless.
  - Lenient coercions observed (recorded, not gate items): `title: 12345`,
    a malformed `dueDate` string, and a bogus `projectId` each answered 200
    and created a task. v1 sends only Core-validated
    `{title, content?, due-tuple?}`, so none of these shapes is reachable.
  - 429: not induced (hammering the live service to force one would be
    abusive); **no rate-limit headers appear on normal responses**. The
    deterministic-4xx → `failed` classification stands as designed.
  - 408 / transient 5xx / mid-flight cuts: not inducible live; the
    default-`unknown` arms stand as designed (the fake-server tests own them).
- **Latency envelope:** n=7 creates — min 73 ms, median 75 ms, max 314 ms
  (first call pays connection setup). The A7 30s timeout is comfortable; the
  card's "Creating in TickTick…" resolves sub-second in the normal case.

**Unresolved** (owned by a slice or an explicitly future feature):

- Agent `complete` (fast-follow candidate; needs task-id provenance from reads
  + its own spike probes). Agent `update`: not planned (stale read-modify-write
  hazard recorded).
- User-direct complete/uncomplete (deferred feature, own spike).
- Exact card layout details (W3 derives them from the first card build).
- Per-task deep link on the created card (W5 candidate, only if a stable URL
  scheme exists).

## The feature in one paragraph

Inkstone gains exactly one write into TickTick: **create a task, through the
Proposal gate**. The model (which can already *read* TickTick through the
Worker's MCP lane) calls a new Core proposal tool, `propose_ticktick_task`,
whose call parks the Run as a pending Proposal — same park/decide/resume
machinery as every Workspace mutation (ADR-0025), same card surface, plus edit.
On accept, Core — not the Worker — executes one `POST` against the TickTick
OpenAPI with the boot-read token (which has carried `tasks:write` since S1),
**outside** the decide transaction, and records a three-valued outcome:
`created | failed | unknown`. Unknown never refires. TickTick remains the sole
authority: Core stores the Proposal and its write state (decision provenance),
never a task row; a created task is visible by re-reading TickTick, not by
trusting a local copy. The Worker's read-only MCP allowlist does not change by
one byte.

```text
Worker ──ticktick_* (5 READ tools, MCP)──────────────► TickTick   (unchanged)
Worker ──propose_ticktick_task (Tool Protocol)──► Core: park Proposal
                                                    │  + ticktick_writes row
                                                    │    {proposed, credential-fp}
                                                    │ user reviews card
                                                    │ (edit title/due/note)
                                          accept ───┤ reject → declined result
              phase A (tx): credential-fp re-check · accepted flip · →executing
                            └─ commit also arms the deadline watchdog
              phase B (no tx): ONE POST /open/v1/task  ──► TickTick
              phase C (tx, guarded settle): outcome + resolve tool call
                                                    │ resume (decision + outcome)
Web ──TanStack────► Core ──OpenAPI reads──► TickTick  + invalidate on created
```

## Assumptions

**W-A1 — Lane: agent writes execute in Core, via OpenAPI, on Proposal accept.**

The brief demanded the case be argued against the shipped invariants, not
assumed. The alternative — widening the Worker's MCP allowlist with write
tools — fails three ways:

1. **There is no park point in the Worker lane.** The gate the product wants is
   "a write dead-ends at a user Decision," and parking is a Core Tool-Protocol
   behavior (`is_proposal` interception in the worker read loop, ADR-0025).
   Worker-executed MCP calls bypass the Tool Protocol *by design* — the
   read-plan A4 lifecycle frames are observational, emitted as pi executes.
   Gating a Worker-lane write means inventing "park an external call": the
   Worker blocks mid-batch, Core persists a Proposal from a frame, tears the
   Worker down, and the *resumed* Worker re-issues a remote call it never made.
   That reintroduces the accept≠execute gap ADR-0025 exists to close — an
   accepted write could then never execute (respawn failure) or execute twice
   (resume replay) — exactly the failure class the two-phase-accept lesson
   exists to prevent.
2. **The read allowlist is THE write barrier, and it must not weaken.** S1
   proved no server-enforced read-only credential exists (MCP rejects
   `tasks:read` even for initialize); the dual exact allowlist is the only
   thing standing between a full-scope token and a model-callable write. Adding
   `create_task` to `EXTERNAL_READ_ALLOWLIST` doesn't "evolve" the invariant —
   it deletes it, for every run with `external_tools = true`, gated by nothing.
3. **Everything a gated write needs already lives Core-side.** Park/decide/
   resume, idempotent decide (`decision_idempotency_key`), `edited_payload`,
   the card surface, and the family-dispatch seam (`RecordObservations` is the
   precedent for a proposable kind with no Entity descriptor). Core owns the
   boot-read full-scope token and the production OpenAPI client
   (`crates/core/src/ticktick/client.rs`) — the write adds one typed function
   beside `fetch_tasks`, not a new lane.

The Worker still participates the right way: the model reads TickTick via the
existing `ticktick_*` tools to inform a proposal, then proposes through the
Tool Protocol like any Proposal. Consequence: the MCP write tools stay
permanently unexposed; the read-lane tests (write tool absent from discovery
AND rejected at the gate) keep passing byte-unchanged.

**W-A2 — Entry point: a dedicated `propose_ticktick_task` proposal tool.**

- **Why not a 13th `ProposableMutation` kind:** (i) *exposure discipline* —
  `ProposableMutation::ALL` IS the `propose_workspace_mutation` descriptor's
  `oneOf` (drift tests pin them equal), so a 13th kind is model-visible the
  moment it exists; the whole family would have to land in the cutover commit,
  contra ship-dark. A dedicated tool's exposure lever is the Workflow
  manifest's `tools` list — the same lever shape the read path used
  (`external_tools = true`). (ii) *vocabulary honesty* — a remote write with a
  three-valued outcome is not a "Workspace mutation," and the Workspace `oneOf`
  (already the largest schema Core ships, fully inlined for Anthropic)
  shouldn't grow TickTick fields for every run while the feature is dark.
  (iii) *model guidance locality* — the tool description carries the
  TickTick-specific rules (Inbox-only, one task per proposal, when NOT to
  propose) where the model reads them.
- **Registry mechanics (verified against master):** a second
  `Dispatch::Proposal` entry in `crates/core/src/tools/mod.rs`; `is_proposal()`
  covers it automatically; the `registry_is_complete_and_consistent` test
  widens from "exactly one Proposal tool" to the exact two-tool set. The tool
  name does not start with `ticktick_` — the reserved external prefix
  (`registry_reserves_the_external_prefix` sweeps the whole REGISTRY, so the
  reservation keeps holding automatically). The call renders as a proposal
  segment, never as an external expandable row.
- **Park-chokepoint mechanics, owned explicitly** (they are NOT free
  inheritance): today `worker/run.rs` validates pre-park via
  `validate_proposal_request` (run.rs:152) and then `park_on_proposal` pulls
  `mutation_kind` from the params with `unwrap_or_default()` — this tool's
  params are the task payload itself, with no `mutation_kind` field, and
  `proposals.mutation_kind` is NOT NULL. W2 therefore (a) derives the stored
  kind from the TOOL NAME for this family (the constant
  `create_ticktick_task`), (b) adds the tool's arm to
  `validate_proposal_request` (full validation before park, like
  `RecordObservations`), and (c) extends the park transaction to insert the
  `ticktick_writes` row in state `proposed` with the credential-fingerprint
  snapshot (W-A3).
- **Pre-park validation:** title non-empty (trimmed); due tuple well-formed
  when present (date parses, `time_zone` non-empty for timed, all-day
  normalized); **connection present AND writable** — no boot-read connection,
  or a parsed `scope` lacking `tasks:write`, fails the propose call as a normal
  tool error ("TickTick is not connected" / "the TickTick token lacks
  tasks:write"), so the model redirects honestly and nothing parks. The token
  file's `scope` field is optional; absent means writable — a provisioning
  convention this plan states rather than hides (S1: any token that works for
  the MCP read lane carries `tasks:write` anyway).
- **One Tool Request = one Proposal = one Decision** holds unchanged: one task
  per proposal; the Worker loop-break parks on the first proposal
  `tool_request`; a model emitting five creates parks on the first, the
  siblings are never read (ADR-0025 mechanics, unchanged).

**W-A3 — The write state machine: `proposed → executing → settled`; one
guarded settle path; never refire.**

The shipped decide envelope (`db/decide_proposal.rs::accept`) runs the family
writer INSIDE the atomic tx — correct for SQLite writes, forbidden for remote
calls. The write family gets a sibling envelope; the entity envelope is
untouched. The family also breaks decide's implicit invariant *accepted ⇒
fully applied*, so the in-flight state is first-class, not inferred:

```sql
CREATE TABLE ticktick_writes (
  proposal_id    TEXT PRIMARY KEY REFERENCES proposals(id),
  credential_fp  TEXT NOT NULL,       -- internal hash of the token reviewed under;
                                      -- never serialized to wire or logs
  state          TEXT NOT NULL DEFAULT 'proposed'
                   CHECK (state IN ('proposed','executing','settled')),
  outcome        TEXT CHECK (outcome IN ('created','failed','unknown')),
  http_status    INTEGER,
  remote_task_id TEXT,
  requested_at   INTEGER,             -- phase-A stamp (the POST intent)
  settled_at     INTEGER,
  CHECK ((state = 'settled') = (outcome IS NOT NULL)),
  CHECK ((state = 'proposed') = (requested_at IS NULL))
                                      -- executing/settled always carry the
                                      -- stamp, so deadline_at is computable
);
```

The effective payload is NOT duplicated here — it remains
`proposals.edited_payload ?? tool_calls.request_payload`, the existing single
sources.

- **At park** (inside the existing park tx): insert the row —
  `state='proposed'`, `credential_fp` = the internal fingerprint (hash) of the
  boot-read token the review will happen under. A reject or a parked-cancel
  leaves the row in `proposed` forever (inert provenance; every active path
  guards on state).
- **Phase A (tx):** re-check `connection()` — it must exist, be writable, and
  the CURRENT token's fingerprint must EQUAL the row's snapshot. The same
  credential matches across restarts (a parked Proposal lives minutes to
  weeks, ADR-0025, and this is a local-first app that relaunches routinely —
  the overnight accept must work); a mismatch means the credential actually
  changed, and the decide fails with the DEDICATED typed error
  `stale_connection` ("the TickTick connection changed since this was
  proposed — reject it and ask again") — never the generic
  `proposal_not_pending`, which the Web reads as "another tab decided" and
  answers with a doomed retry. The tx rolls back, the Proposal stays pending
  (reject remains available, accept is disabled card-side), and **no POST ever
  fires**. **The EFFECTIVE payload is validated here too**
  (`edited_payload ?? original`, through the SAME validator as pre-park —
  title trimmed non-empty, due tuple well-formed): pre-park covered only the
  model's original params, and an edit REPLACES what phase B sends, so an
  unvalidated empty-title or malformed-due edit would sail to TickTick and
  burn the accept on a 400 → `failed`. A fresh invalid edit rejects
  `invalid_params` with ZERO state change — before any flip, before any POST.
  **Position inherits ADR-0025's ordering lesson explicitly:** the validation
  sits on the FRESH apply path, AFTER the idempotency-replay and
  already-decided recovery branches — a malformed (or payload-less) edit
  RETRY of an already-executing decide answers "executing" (family recovery),
  never `invalid_params`; hoisting the check ahead of recovery is the exact
  regression the entity family hit during implementation. On a match with a
  valid payload: guarded `pending → accepted` flip (the same single
  concurrency choke), stamp `edited_payload` + `decision_idempotency_key`,
  guarded `proposed → executing` flip + `requested_at`. COMMIT — which also
  **arms the deadline watchdog** (below). The awaited `tool_calls` row stays
  PENDING; the Run stays parked.
- **Phase B (no tx):** exactly one `POST` via
  `crate::ticktick::client::create_task(token, payload)` under the read-plan A7
  timeout (default 30s; the loopback-guarded URL override serves the fake
  server in tests).
- **Phase C — the ONE guarded settle path:** a single function owns
  `executing → settled`: in one tx, guarded flip to `settled` + outcome (+
  `remote_task_id` / `http_status`), resolve the awaited tool call `completed`
  with the outcome-bearing Decision payload, COMMIT; then re-drive resume
  (self-guarded `parked → running` — a cancelled or already-running Run is a
  no-op). Every settle — normal completion, boot sweep, stale reconciliation —
  goes through this function; losing the guarded flip means someone else
  settled, so the loser reads and returns the recorded outcome.
- **Outcome classification — an EXHAUSTIVE match whose default arm is
  `unknown`** (confirmed by W1; per-status observations in the ledger's
  "Resolved by W1" section). The classifier is a
  match over (HTTP status, reqwest error predicate); a response or transport
  error that fits no explicit arm classifies `unknown` — a novel failure mode
  can never classify `failed`:

  | response | outcome |
  |---|---|
  | 2xx, body decodes to a NON-EMPTY task id | `created` (+ task id) |
  | 2xx, body undecodable, id-less, or a decodable error envelope | `unknown` (cannot confirm creation — W1 observed an undecodable 2xx in the wild; no decodable 2xx error envelope was seen) |
  | 4xx except 408 (400/401/403/404/413/422/429…) | `failed` — deterministic rejection, nothing created (W1: 401 confirmed; TickTick wears VALIDATION rejections as 500, so this arm mostly means auth/protocol-level rejections) |
  | 408 | `unknown` |
  | any 5xx | `unknown` — a gateway error can follow an upstream commit (and W1 shows a 500 can ALSO be a deterministic validation rejection — indistinguishable, so `unknown` stands) |
  | connect/TLS failure BEFORE anything was sent (reqwest `is_connect`) | `failed` |
  | send/read timeout, mid-flight reset, response-read failure | `unknown` |
  | anything else (the default arm) | `unknown` |

  `failed` is reserved for "TickTick deterministically did not create this" —
  a deterministic 4xx or a pre-send connect failure, nothing else; everything
  ambiguous is `unknown`, because a `failed` that was actually created invites
  a duplicate re-propose.
- **Decide runs DETACHED; the response still carries the outcome.** Core's
  per-connection socket loop awaits each dispatch inline and owns outbound
  sends in the same `select!` (`main.rs`), so an inline A→C decide would
  freeze the connection both directions for up to the A7 timeout: other Runs'
  event tails stall mid-accept, and a same-socket `run/cancel` could not
  arrive during phase B at all — it would queue, land after settle+resume, and
  kill the freshly resumed Worker before the model narrates the outcome. The
  write-family decide handler therefore runs as its own spawned task and
  replies by request id on the connection's `out_tx`: the caller's contract is
  unchanged (one request, one response carrying the outcome, bounded by the A7
  timeout), the socket keeps reading and writing throughout, and the card's
  "Creating in TickTick…" remains the caller's own pending-response state —
  never notification-dependent. (Named pre-existing issue, out of scope:
  `ticktick/tasks/list` already blocks the loop the same way today.)
- **Settlement has an OWNER — the guarded settle runs from exactly three
  triggers, and reads are never one of them:**
  1. **Phase C** — the normal path, inside the detached decide task.
  2. **The deadline watchdog** — armed by phase A's commit; fires at
     `requested_at` + A7 timeout + grace and runs the guarded settle (a no-op
     if phase C already settled). **Blast-radius independence is the point:**
     the watchdog is its OWN spawned task, keyed by the write row — NOT a
     timeout combinator wrapped around the POST inside the decide task. A
     panic or abort anywhere in phase B kills that task silently (a detached
     task's panic is swallowed once its JoinHandle drops); a co-located
     watchdog would die with it and the row would stick at `executing` until
     a restart — precisely the failure class the watchdog exists to remove.
     Independent, it settles `unknown`, resolves the tool call, and resumes
     the Run with NO user input and NO restart. It never POSTs — it only
     settles.
  3. **The boot sweep** — the crash owner (below).
  Belt on top of the owner: a past-bound decide replay may also run the
  guarded settle (a decide is already a write) — and the card's post-deadline
  "Resolve now" action (W-A4) is exactly this belt, made user-reachable.
  `thread/get` and `proposal/get` NEVER settle: reads stay pure and replayable
  (a page reload must not spawn a Worker as a rendering side effect) — clients
  only ever OBSERVE settlement; when they cause it, it is through a decide,
  which is a write.
- **Recovery and replay** (`accepted` no longer implies applied — every
  recovery path is family-aware):
  - A keyed replay or an already-decided/still-parked recovery that finds
    `state='executing'` answers **"executing"** — it does NOT re-drive resume
    (the awaited tool call is unresolved; a resume transcript would be
    provider-invalid) and does NOT re-POST. Past the bound it may run the
    guarded settle itself (a decide is already a write); within the bound the
    watchdog owns the deadline, so no caller has to poll to MAKE settlement
    happen — the client's bounded observe-poll (W-A4) merely watches it land.
  - Once `settled`, replays return the recorded outcome — never a second POST.
- **Boot sweep** (beside the ADR-0012 recovery sweep in `main.rs`), covering
  BOTH crash windows: rows in `executing` → settle `unknown` (guarded path:
  resolve tool call, resume); rows in `settled` whose Run still reads `parked`
  (the crash landed after phase C's commit but before resume) → re-drive
  resume only, reusing the stored tool result — **no POST in either branch**.
- **Cancel is a state matrix** (see W-A4 for the UX). Today's parked-cancel
  can move a Run only by cancelling a PENDING proposal (verified:
  `db::cancel_parked_run` bails when no pending proposal exists → the handler
  answers `already_terminal`, which the Web settles LOCALLY as cancelled) — so
  without new arms, the accepted states would fake "stopped" over a live or
  about-to-resume write. The matrix:
  - `proposed` (proposal pending): the existing parked-cancel path — cancel
    proposal + Run, unchanged.
  - `executing`: REFUSED — `run/cancel` answers the new `write_in_flight`
    outcome and changes nothing; the Web keeps the card and the subscription.
  - `settled` + Run still parked (the phase-C-commit → resume window):
    parked-cancel gains an accepted+settled arm — a REAL `parked → cancelled`
    CAS racing resume's self-guarded `parked → running`. Cancel wins: no
    spawn, terminal `cancelled`, the recorded outcome stays readable on the
    card. Resume wins: the handler re-reads `running` and routes through the
    normal running-cancel. Either way the response reflects the durable state
    the Web settles on — never a local guess.
  - `running` (post-resume): the existing running-cancel, unchanged.
- **Reject:** unchanged single-tx reject (flip + the declined tool result); the
  `proposed` row stays inert; no HTTP.
- **Model-facing Decision results** (all `is_error: false` — the Decision
  resolved; the outcome is content the model must relay):
  - `created`: `Accepted. Created "<title>" in TickTick (task <id>).`
  - `failed`: `Accepted, but the TickTick write FAILED (HTTP <status>). The
    task was NOT created. Do not retry on your own — tell the user, and let
    them re-ask or add it in TickTick.`
  - `unknown`: `Accepted, but the write outcome is UNKNOWN (the request may or
    may not have reached TickTick). Ask the user to check TickTick before
    proposing it again.`

**W-A4 — The card, the durable outcome, and Stop.**

- **One durable execution-outcome shape, everywhere the Client looks.**
  `accepted` is only the human Decision; the write result is its own value:

  ```text
  TickTickWriteState =
      {state:"proposed", stale_connection: bool}   // pending card, staleness
    |                                              //   DERIVED at read
      {state:"executing", deadline_at}             // absolute epoch-ms:
    |                                              //   requested_at + A7 + grace
      {state:"created", task_id?}
    | {state:"failed", http_status?}
    | {state:"unknown"}
  ```

  The `proposed` variant exists because the write row exists from park: every
  read of this family's Proposal — `proposal/get` while pending, and
  `Segment.proposal.ticktick_write` on reload — carries the derived
  `stale_connection` (row fingerprint vs current boot fingerprint, or no
  connection), so a stale card warns on FIRST render in any tab, not merely
  after a failed accept. The `executing` variant carries **`deadline_at`,
  computed Core-side** — the client has neither `requested_at` nor the A7
  knob's value (`INKSTONE_TICKTICK_TIMEOUT_MS` is a server env knob), so a
  client-computed cap would break the moment the knob isn't default; the
  Core-supplied absolute deadline makes the poll knob-agnostic. Present on the
  decide response, the replay answer, and the segment alike.

  Carried on: (1) the `proposal/decide` response (`ProposalDecideResult` gains
  optional `ticktick_write`) — the DECIDING tab's live source; (2)
  `proposal/changed`, which for this family fires TWICE — at accept
  (`accepted` + `executing`) and at settle (`accepted` + terminal state) — and
  reaches **the deciding connection only** (verified `runs/reply.rs`; there is
  no cross-connection broadcast, ADR-0025 as-built). **The cross-tab promise
  is therefore scoped honestly:** a second tab converges on its next
  `thread/get`, not live; multi-tab live Proposal sync stays explicitly
  deferred. (3) The durable `Segment.proposal` gains the same optional
  `ticktick_write` field served from the `ticktick_writes` row (`thread/get`
  is the reload/reconcile path — `proposal/get` stays pending-only). Web
  hydration maps it. **Pinned: live and reload render identically for all four
  states** — a reload during phase B shows "creating…" (executing), never a
  generic accepted; a settled `failed`/`unknown` never rehydrates as a
  success-shaped card.
- **Pending card:** glyph + "Create task in TickTick", the title, the due
  rendered from the one due tuple (all-day vs timed, localized), the note, and
  a fixed "→ Inbox" affordance. Rationale chip as on other kinds.
- **Edit** (Agreed): title (text), due (date; optional time — clearing the time
  sets `is_all_day`; timezone defaults to the payload's, else Core-local), note
  (textarea). The card submits the FULL effective payload as `edited_payload`
  (replace semantics, like every non-Todo kind since ADR-0033's replace
  doctrine).
- **Terminal states:** `created` (✓ "Created in TickTick" + task id; when the
  current Tasks read has `source_limit_reached`, an inline caveat "may not
  appear in the Tasks view — TickTick returned its 200-item limit"); `failed`
  (✗ "Not created — TickTick returned HTTP <status>"); `unknown` (? "Outcome
  unknown — check TickTick before re-asking"); `rejected` (existing rendering).
  States differ by glyph + label, never color alone.
- **Stop during "creating…" is refused, honestly — and it can actually
  arrive.** Today the composer keeps Stop visible while a Proposal decides
  (`ChatColumn.tsx`), parked-cancel can only cancel a PENDING proposal
  (`db::cancel_parked_run` bails otherwise → `already_terminal`), and the Web
  settles `already_terminal`-on-parked as a successful LOCAL cancel
  (`bridge.ts` `settleCancelledLocally`) — with a 30s POST that means
  "stopped" on screen while TickTick creates the task and the Run resumes.
  v1 rules: (i) the detached decide (W-A3) keeps the socket alive, so a
  same-tab Stop actually reaches Core during phase B; (ii) while the write row
  reads `executing`, `run/cancel` returns `write_in_flight` — the Web does NOT
  settle locally, keeps the card and the subscription, and shows "Creating in
  TickTick — can't stop while the write is in flight"; (iii) in the
  settled→resume window, cancel is a real CAS (W-A3's matrix) and the Web
  settles on Core's answer. The accept → held-POST → Stop race is pinned in
  W3 verify, in BOTH shapes: same-socket and a second connection; plus a
  post-phase-C-commit cancel/resume race asserting both orderings converge.
- **The stale-connection card state is derived, so it survives everything:**
  the pending read shape's `stale_connection` (derived from the durable
  fingerprint — see the union above) renders the warning with accept DISABLED
  and Reject enabled on first render in ANY tab, after ANY reload — never a
  connection-local flag that a refresh resets into a doomed retry loop. The
  typed `stale_connection` decide error remains the enforcement for the
  pre-restart-card race, and rendering it matches what the next read would
  have derived anyway.
- **A reloaded "executing" card polls to the outcome, boundedly — and the
  bound comes from the wire.** The creating… state is normally the caller's
  own pending-response state — but an F5 or reconnect mid-write drops that
  pending response (and the per-tab decision bookkeeping), the settle reply
  targets the ORIGINAL connection's now-dead `out_tx`, a parked Run has no
  hub, and `proposal/changed` is deciding-connection-only — so a fresh tab
  hydrating `executing` would otherwise sit at creating… forever over a
  durably settled write. W3 rule: an `executing` entered from hydration or
  replay starts a `thread/get` poll (short interval) capped by the variant's
  **Core-supplied `deadline_at`** plus a small ε — never a client-computed
  bound. The watchdog guarantees the server settles by that deadline in every
  designed case, so the poll normally ends at the recorded outcome with no
  user action. Polling OBSERVES; it never settles (W-A3).
- **Past the deadline, the card is honest, not eternal.** The watchdog
  guarantee is strong but not absolute (its settle tx can hit a DB error; its
  task can die) — if `deadline_at` + ε passes and the read STILL says
  `executing`, the poll stops and the card renders a truthful terminal-ish
  state: "Still unresolved — no outcome recorded; check TickTick before
  re-asking," with a **Resolve now** action. Resolve-now issues a plain
  `proposal/decide` re-decide — a WRITE, so it may legitimately run the
  guarded settle (the past-bound belt, W-A3): the row settles `unknown`, the
  Run resumes, the card re-reads to `unknown`. Never an eternal creating…,
  never a read with side effects.
- **Mechanics:** one new row in `proposalViews.tsx`'s per-kind table (the table
  is explicitly designed so "a new kind is one new row"), a new edit policy for
  the TickTick payload form.

**W-A5 — Read-back and the 200-cap, honestly.**

- **Web lane:** on a decide response with outcome `created`, the deciding
  client invalidates the `["ticktick","tasks"]` prefix
  (`TASKS_KEY_PREFIX` in `apps/web/src/lib/hooks/useTickTick.ts`) — the next
  Tasks render refetches under the current connection ID. Other tabs converge
  by the existing policy (60s staleTime, focus/reconnect refetch) — the
  ADR-0033 self-invalidation precedent for a single-user product (ADR-0007).
- **Worker lane:** nothing to invalidate — the lane is read-through; a
  subsequent `ticktick_filter_tasks` in the resumed Run re-queries live
  TickTick. TickTick's own indexing latency is not ours to promise; the plan
  makes no read-your-write claim for the MCP lane.
- **The 200-cap interaction, stated plainly:** a created task can exist in
  TickTick yet be invisible in the Web Tasks view — the filter read returns at
  most 200 open entries with no cursor, so at the cap the new row may fall
  outside the page. The shipped `sourceLimitReached` banner already marks the
  view incomplete; the created card carries the task id and (at the cap) the
  inline caveat. No fan-out, no second read path — the accepted product limit
  stands.

**W-A6 — The safety invariant, precisely.**

After cutover the complete write surface is:

- **Exactly one remote write endpoint** — task create — reachable through
  **exactly one path**: `propose_ticktick_task` → parked Proposal → manual
  accept (credential-fingerprint-checked) → `client::create_task`. The client
  gains a typed create function, never a generic request builder.
- **Never exposed, anywhere:** delete, move/re-file, bulk operations, comments,
  complete/update (v1), any Worker-lane MCP write tool, any runtime-configurable
  endpoint (the base URL stays compile-time-const with the loopback-only test
  override).
- **The Worker read lane is byte-identical:** `EXTERNAL_READ_ALLOWLIST`
  unchanged; the "write tool absent from discovery AND rejected at the
  execution gate" tests keep passing UNCHANGED — joined by new Core-side tests:
  the registry holds exactly the two proposal tools; the reserved `ticktick_`
  prefix still rejects every Core registration (the existing whole-REGISTRY
  sweep covers the new tool automatically); the write family is unreachable
  from `entity/mutate` and from `apply_entity_mutation`; no auto-approve arm
  exists for the family; a swapped or removed credential can never be written
  with under a stale review (the phase-A fingerprint check — while a plain
  same-credential restart still accepts, so the guard never strands an
  overnight Proposal).
- **Auto-approve: hard-barred** (Agreed). The family's decide path has no auto
  branch; ADR-0065 records the bar and its only unlock condition (a real
  idempotency contract from TickTick), and restates mcp-A14.
- **Credentials: zero change.** The boot-read token has carried `tasks:write`
  since S1 — the write feature adds capability *use*, not credential surface.
  The only addition is READING the already-provisioned file's optional `scope`
  field to refuse scope-short tokens before review. A5 (read once at boot,
  restart to change) holds.
- **Prompt-injection posture:** a hostile read result can at worst make the
  model *propose*; the card shows exactly what will be written; nothing writes
  without a human accept. One-per-park means "create 500 tasks" parks once on
  the first proposal and the sibling calls are never read.

**W-A7 — Idempotency and retry.**

- Create is NOT idempotent — W1's duplicate probe made two tasks with
  distinct ids from two identical POSTs. The structure already assumes the worst: the
  guarded `executing → settled` flip is the once-guard; keyed replay returns
  the recorded outcome (or "executing"); the boot sweep and the stale
  reconciliation settle — never re-send; ambiguity classifies as `unknown`,
  not `failed`.
- The user's retry is a NEW proposal (re-ask the agent). After an `unknown`,
  the model is instructed to have the user check TickTick first.
- Rate limits: W1 probed for the record — a 429 is not safely inducible and no
  rate-limit headers appear on normal responses; the 4xx table row stands
  (429 → `failed` — rejected before processing); v1 ships no throttling
  machinery — one write per human accept means the human is the rate limiter.

**W-A8 — Config and vocabulary.**

- No new config. The read-plan A7 timeout knob and the loopback-guarded URL
  override are the shipped ones; the fake-HTTP write server rides the same seam
  the read tests use. No TTL, no queue depth, nothing to tune.
- **Vocabulary:** *TickTick write* (the remote create); *write state*
  (`proposed | executing | settled`); *write outcome*
  (`created | failed | unknown`); *`propose_ticktick_task`* (the proposal
  tool); *`ticktick_writes`* (the state table). Avoid: sync, queue, retry,
  draft task, pending write (the PROPOSAL pends; a write is `executing` for at
  most one bounded call and then settles).

## The cutover (W4 — what un-deletes)

The redirect is load-bearing in FOUR places plus its test guards — W4 owns the
full list, or it lands red:

- **`default.toml`, three sites:** the main redirect block (~L26–31: "tell them
  plainly to add it in TickTick — do not propose any Workspace mutation for
  it… you cannot create or edit tasks from here"), the Project-action guidance
  (~L42: "the action is a task — point them to TickTick for it"), and the
  graph-section repeat (~L98: "it belongs in TickTick, not in the graph"). All
  three rewrite to: for a reminder/task, propose ONE TickTick task via
  `propose_ticktick_task` (title; due only when the user gave one; note for
  context; it lands in Inbox); you may read `ticktick_*` first to avoid
  duplicates; you still cannot complete, edit, or delete tasks; still never a
  Journal Entry for a bare reminder. Plus: `tools` gains
  `propose_ticktick_task`.
- **The prompt-boundary guards:** the shared fixture
  `crates/core/tests/fixtures/prompt-boundary-worker.ts` — its
  `hasReminderBoundary` predicate requires today's exact redirect phrases
  ("add it in ticktick", "do not propose any workspace mutation for it") and
  deliberately rejects softened variants — is rewritten to pin the NEW
  boundary: reminders → `propose_ticktick_task`, never a Journal Entry, never
  a direct write. Both consumers update with it: the Core-side prompt test and
  `tests/e2e/src/prompt-boundary-worker.spec.ts`.
- **ADR-0065 "TickTick task creation through the Proposal gate"** — amends
  ADR-0064 (supersedes its "No task writes" decision in part — including its
  prose claim that the prompt redirects), records W-A1 (lane), W-A3
  (state machine + two-phase + classification + never-refire, restating
  mcp-A14's sentence verbatim), W-A6 (the invariant), the auto-approve hard
  bar, and that the read lanes did not change.
- **CONTEXT.md:** the task vocabulary gains the write-path sentence.
- The demo proofs run end-to-end.

## Slices (each independently landable, gate-green)

| # | Slice | Contents | Verify |
|---|-------|----------|--------|
| W1 | **Write-contract spike (go/no-go gate) — COMPLETE (2026-08-19, GO)** | Probe scripts against the disposable smoke account, live-smoke privacy posture (status-only errors, never a body, no real content, nothing captured to the repo; **manual dispatch only — never scheduled**): create happy-path + response shape (id? projectId?); duplicate double-POST; create WITHOUT projectId → Inbox?; due-tuple round-trip on create (all-day + timed + timezone) via the filter read; note field (`content` vs `desc`); **the outcome-classification table confirmed per status (4xx family, 408, 429 + headers, 5xx, 2xx-with-error-envelope?)**; latency sample; spike cleans up its staged rows via the API (tooling-only capability, never product) | Ledger's "resolved by W1" section filled incl. the confirmed classification table; go/no-go verdict recorded; no captures or fixtures with real content committed; `scripts/ticktick-live-smoke.mjs` (read smoke) untouched; a write-smoke script may land beside it, manual-dispatch only |
| W2 | **Core write family (hidden)** | `propose_ticktick_task` tool (second `Dispatch::Proposal`); `validate_proposal_request` arm (title/due-tuple/connected/writable); park path: kind derived from tool name (`create_ticktick_task`; today's `unwrap_or_default` would store "") + `ticktick_writes` `proposed` row w/ credential-fingerprint snapshot inside the park tx; token boot-read parses optional `scope` → `Connection.writable` + computes the internal fingerprint; `create_ticktick_task` family in decide (`StoredMutation` third variant — never the entity path); **the DETACHED decide handler** (spawned task, reply by request id — the socket keeps reading/writing during phase B); phase A (fingerprint re-check → typed `stale_connection` error on mismatch + accepted flip + `proposed→executing` + **arms the deadline watchdog — its OWN spawned task keyed by the write row, independent of the decide task**); phase B `client::create_task` (A7 timeout, loopback-guarded override); **the ONE guarded settle fn with exactly three triggers** (phase C, the watchdog, the boot sweep; past-bound decide replay as belt — reads never settle); family-aware replay/recovery (executing → "executing", no resume, no POST); boot sweep BOTH branches (executing→unknown; settled-but-parked→resume only); the cancel state matrix (proposed→existing path; executing→`write_in_flight`; settled+parked→real `parked→cancelled` CAS racing resume); the **exhaustive default-arm-unknown classifier** (`created` requires a decoded non-empty task id; `failed` ⊆ deterministic 4xx ∪ `is_connect`); **effective-payload validation on the fresh apply path** (same validator as pre-park; positioned AFTER replay/recovery — the ADR-0025 ordering lesson); the second schema CHECK (`proposed ⇔ requested_at IS NULL`); wire: `ProposalDecideResult.ticktick_write`, `proposal/changed` ×2 (deciding connection), `Segment.proposal.ticktick_write` INCLUDING the derived `{state:"proposed", stale_connection}` pending variant (also served by `proposal/get`) AND `{state:"executing", deadline_at}` (Core-computed `requested_at` + A7 + grace — the client never computes the bound), the `stale_connection` decide error, the `write_in_flight` cancel outcome; the three Decision-result texts; the tool is in NO workflow's `tools` list (model-unreachable) | Envelope ordering: the fake write server observes the proposal row already `accepted`+committed when the POST arrives; classifier unit tests over the full table INCLUDING the default arm (a novel transport error → `unknown`) and created-requires-id (a decodable id-less/error-envelope 2xx → `unknown`); **crash-point tests: after phase A, during the POST, after phase C before resume** — sweep settles/resumes correctly, ZERO extra POSTs (fake client counts); **watchdog fault test: phase-C persistence failure → one immediate same-key retry answers "executing" → NO further input → the watchdog settles `unknown`, resolves the tool call, resumes the Run** (and never POSTs); **watchdog independence fault test: panic/abort the decide task mid-POST → the independently-spawned watchdog STILL settles `unknown` + resolves + resumes without a restart** (a combinator-in-the-decide-task implementation fails this test by construction); **same-credential restart → accept SUCCEEDS (the overnight flow)**; **swapped-credential restart → typed `stale_connection`, zero POSTs, reject still works**; scope-short token → propose rejected pre-park; not-connected propose → tool error, no park; **fresh malformed edit (empty title / bad due) → `invalid_params`, nothing flips, no POST; same-key malformed edit RETRY while executing → answers "executing", never `invalid_params`**; reject leaves the `proposed` row inert, no call; parked-cancel during executing → `write_in_flight`, nothing changes; **post-phase-C-commit cancel/resume race (two connections, paused before resume): both orderings converge, the response matches durable state**; **the socket stays live during phase B** (a subscribed Run keeps streaming while a decide executes); registry: exactly two proposal tools + prefix reservation; fake-HTTP e2e: propose → park → accept → POST → resume transcript carries the `created` content; gate green |
| W3 | **Card + read-back (dormant)** | `proposalViews.tsx` row for `create_ticktick_task` (pending / executing / created / failed / unknown / rejected / **stale-connection**); the TickTick edit form (title, due + all-day, note → full-payload `edited_payload`); "→ Inbox" affordance; decide-response handling ("Creating in TickTick…" from the caller's own pending response); **the stale-connection card: DERIVED from the pending read shape's `stale_connection`, so the warning + disabled accept + enabled reject render on FIRST render in any tab after any reload** (the typed decide error covers only the pre-restart-card race; neither path funnels into the generic `proposal_not_pending` refetch); **the bounded executing poll: an `executing` entered from hydration/replay polls `thread/get` (short interval) capped by the wire's `deadline_at` + ε — never a client-computed bound — until the recorded outcome renders (observation only, never settlement); past the deadline with the read still executing, the poll stops and the card renders "still unresolved — check TickTick" with a Resolve-now re-decide (the past-bound belt, a write)**; `write_in_flight` cancel handling (keep card + subscription, honest copy — never a local "cancelled" over a live write); cancel-response handling for the settled-window CAS (settle only on Core's answer); hydration maps `Segment.proposal.ticktick_write` (a second tab converges on its next `thread/get` — no live cross-tab claim); `TASKS_KEY_PREFIX` invalidation on `created` only; created-at-cap inline caveat | Component tests for every card state incl. executing + unknown + stale-connection (accept disabled, reject works); **credential mismatch → reload → accept STILL disabled, message still rendered, reject works, zero POSTs** (the derived state survives reload/second tab); **reload-mid-B test: F5 during a held POST → the fresh tab hydrates "creating…" and reaches the recorded outcome with NO user action** (bounded poll observed to stop after settle); **deadline-residue test: suppress settlement past `deadline_at` → the poll stops, the card renders "still unresolved" (not eternal creating…), and Resolve-now settles `unknown` and re-renders it**; **live == reload pinned for all states** (reload during phase B renders "creating…", settled failed/unknown never rehydrate success-shaped); edit round-trip emits the full edited payload; **accept → held-POST → Stop race in BOTH shapes — same-socket (reaches Core mid-B thanks to the detached decide) and second-connection — cancel answers `write_in_flight`, card survives, outcome lands**; invalidation fires on `created` and only then; existing proposal-card tests untouched; states differ by glyph + label, never color alone |
| W4 | **Cutover: expose + prompt + ADR** | `default.toml` `tools` += `propose_ticktick_task` + ALL THREE prompt sites rewritten (~L26–31, ~L42, ~L98); `hasReminderBoundary` fixture rewritten to the new boundary + both consumers (Core prompt test, `tests/e2e/src/prompt-boundary-worker.spec.ts`); ADR-0065 (amends 0064, restates mcp-A14); CONTEXT.md sentence; demo proofs | Gate green; **read-lane tests UNCHANGED and green** (dual allowlist byte-identical); the rewritten boundary predicate still REJECTS softened variants (asserted both consumers); e2e: "remind me to buy milk" parks a `create_ticktick_task` proposal (and no Journal Entry); accept → task in fake TickTick → Tasks view shows it post-invalidation; reject → no task, conversational continue; extraction e2e still proposes no Todos and no tasks-as-Projects |
| W5 | **Polish (only if the first usable flow demands)** | Named candidates ONLY: per-task deep link on the created card (if a stable URL scheme exists); agent `complete` (own mini-spike); user-direct complete (deferred feature); the inherited `ticktick/status` expiry hint | Whatever ships gets its e2e; nothing else |

Definition of done per slice: `pnpm format && pnpm lint && pnpm check &&
pnpm -r test` green, plus `cargo check` and
`cargo test --manifest-path crates/core/Cargo.toml`.

## The demo that proves it (post-W4)

1. **HEADLINE — capture returns:** "remind me to buy milk" → proposal card
   (title/due/note editable) → accept → "Creating in TickTick…" → ✓ created
   (task id) → the task is visible in the Tasks Topic (invalidated read) and in
   TickTick itself.
2. **Reject:** → nothing lands in TickTick; the model continues
   conversationally (normal, non-error decline).
3. **Edit:** fix the model's wrong due date on the card → the created task
   carries the edited date (`edited_payload` wins; the effective payload is
   what phase B sends).
4. **Crash honesty, both windows:** kill Core during the POST → reboot → the
   card and the resumed model both say outcome unknown; kill Core after the
   outcome commits but before resume → reboot → the Run resumes with the
   recorded outcome. No window ever produces a duplicate task on any replay.
5. **Stop honesty:** hit Stop in the SAME tab while "Creating in TickTick…" —
   it reaches Core mid-write (the decide no longer freezes the socket) and is
   refused (`write_in_flight`); the card stays and the real outcome lands —
   never a fake "stopped" over a live write.
6. **Account honesty, both directions:** swap the credential file + restart
   while a proposal is parked → accept is refused with the named
   stale-connection message (accept disabled, reject works), zero POSTs; a
   plain restart with the SAME credential → the morning accept succeeds — the
   guard never strands an overnight Proposal.
7. **The barrier held:** Worker discovery still exposes exactly the 5 read
   tools; the execution gate still rejects a write name; the read-lane tests
   pass byte-unchanged.
8. **No task state:** SQLite gains only `proposals` / `tool_calls` /
   `ticktick_writes` rows (decision + write provenance) — zero task rows, zero
   cache.

## What this feature deliberately does NOT do

No queue or retry daemon; no sync engine; no agent complete/update/delete; no
user-direct writes; no auto-approve; no projectId/tags/priority in the v1
payload (Inbox-only capture); no per-task deep links (W5 candidate); no
multi-tab live Proposal sync (a second tab converges on read — deferred, as it
is for every Proposal today); no second provider; no new credential surface.
(The watchdog is a settle-only deadline, not a retry daemon: it never POSTs.)
