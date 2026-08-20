# TickTick task creation through the Proposal gate

Status: Accepted

/ amends [ADR-0064](./0064-task-ownership-moves-to-ticktick.md) — supersedes its
"No task writes" decision **in part** (create only), including its prose that
the default Workflow prompt redirects a reminder to TickTick with no mutation
/ builds on [ADR-0016](./0016-proposal-application-policy.md),
[ADR-0025](./0025-proposal-park-and-resume.md),
[ADR-0023](./0023-provider-oauth-core-owned-credentials.md)

ADR-0064 made TickTick the sole task authority and, with it, deliberately
removed a capability: *"Until a future write feature, Inkstone cannot create or
edit a task."* Chat task capture died at that cutover — "remind me to buy milk"
produced nothing anywhere, and the agent's honest move was to tell the user to
add it in TickTick themselves.

This is that future write feature, at its smallest honest size. Inkstone gains
**exactly one write into TickTick: create a task, through the Proposal gate.**
Everything else ADR-0064 removed stays removed.

## Decision

**One write, one path.** The model calls a dedicated proposal tool,
`propose_ticktick_task`, whose call **parks the Run as a pending Proposal** —
the same park/decide/resume machinery as every Workspace mutation (ADR-0025),
the same card surface, plus edit (title / due / note). On accept, **Core** — not
the Worker — executes one `POST /open/v1/task` with the boot-read token. The
v1 payload is `{title, note?, due?}`: every agent create lands in TickTick's
**Inbox** (capture → Inbox → the user organizes in TickTick). No agent-proposed
complete, update, or delete; no user-direct writes; no projectId, tags, or
priority.

**Not the Worker's MCP lane.** The Worker's read-only `ticktick_*` allowlist is
unchanged, and MCP write tools stay permanently unexposed. The gate the product
wants is "a write dead-ends at a user Decision," and parking is a Core
Tool-Protocol behavior — Worker-executed MCP calls bypass the Tool Protocol by
design. Gating a Worker-lane write would mean inventing "park an external
call," which reintroduces the accept≠execute gap ADR-0025 exists to close.
Widening `EXTERNAL_READ_ALLOWLIST` would not evolve that barrier; it would
delete it for every Run with `external_tools = true`, gated by nothing.

**A remote write is never inside a transaction.** The shipped decide envelope
runs the family writer inside the atomic accept tx — correct for SQLite,
forbidden for a network call. The write family gets a **sibling envelope** and a
first-class state machine, `proposed → executing → settled`, in a
`ticktick_writes` row created at park:

- **phase A** (tx): re-check the credential, flip the Proposal `pending →
  accepted`, flip the write `proposed → executing`, stamp `requested_at`,
  commit — and arm the deadline watchdog. The awaited tool call stays pending;
  the Run stays parked.
- **phase B** (no tx): exactly ONE POST, under the per-request timeout.
- **phase C** (tx): the ONE guarded settle — `executing → settled` plus the
  outcome, resolve the awaited tool call with the outcome-bearing Decision,
  commit, then re-drive resume.

**The outcome is three-valued: `created | failed | unknown`** — classified by an
exhaustive match whose DEFAULT arm is `unknown`, so a novel failure can never
classify `failed`. `created` requires a decoded response with a non-empty task
id; `failed` is reserved for "TickTick deterministically did not create this"
(a deterministic 4xx, or a pre-send connect failure); everything ambiguous —
5xx, 408, timeouts, mid-flight cuts, undecodable or id-less 2xx — is `unknown`.

**`unknown` NEVER re-fires.** Restating the surviving invariant of the abandoned
MCP-connectors design (its assumption A14) verbatim, so it is no longer anchored
to a mostly-lost artifact:

> *Unknown never re-fires — crash between approve and record settles the action
> as unknown; no auto-retry without an idempotency contract.*

The guarded `executing → settled` flip is the once-guard; a keyed decide replay
returns the recorded outcome (or "executing"); the boot sweep and the deadline
watchdog **settle without ever sending**. The user's retry is a NEW Proposal.

**Settlement has an owner that outlives the task it watches.** Exactly three
triggers run the guarded settle: phase C, the **deadline watchdog** (its own
spawned task, keyed by the write row — a panic in phase B kills the decide task
silently, and the watchdog still settles `unknown`, resolves, and resumes with
no restart and no user input), and the **boot sweep** (rows left `executing` →
`unknown`; rows `settled` whose Run still awaits that write → resume only).
Reads NEVER settle — a page reload must not spawn a Worker as a rendering side
effect; clients only observe settlement, and when they cause it, it is through
a decide, which is a write. Every resume decision is guarded on the Run being
parked **awaiting that write's own tool call**, so an old write's residue can
never resume a Run that has since re-parked on a different Proposal.

**Auto-approve is hard-barred for this family.** Every TickTick write is a
manual Decision. External writes are excluded from any future auto-approve
policy until TickTick offers an idempotency contract; the family's decide path
has no auto branch, and reopening this requires amending this ADR — not
flipping a manifest flag.

**Credentials: zero new surface.** The boot-read token has carried
`tasks:write` since the read-lane spike; this feature adds capability *use*, not
credential surface. Two reads are added: the token file's optional `scope` (a
scope-short token refuses at propose time, before review) and an **internal
fingerprint** of the access token, snapshotted on the write row at park.
Phase A re-checks it: the SAME credential matches across any number of restarts
(the propose-at-night / accept-in-the-morning flow works), while a real
credential change refuses with a dedicated typed error and **no POST**. The
fingerprint is never serialized to the wire or logs.

## Consequences

- **Capture returns.** "Remind me to buy milk" becomes a reviewable, editable
  Proposal that lands in TickTick's Inbox on accept. The default Workflow's
  prompt now says exactly that, in all three places it previously redirected.
- **`accepted` no longer implies `applied`.** The write outcome is its own
  durable value, carried everywhere the Client can look (the decide response,
  `proposal/changed`, `proposal/get`, and the durable transcript segment), so
  live and reload render identically for every state — a reload mid-write shows
  "creating…", and a settled `failed`/`unknown` never rehydrates
  success-shaped.
- **Stop during a write is refused honestly.** `run/cancel` answers
  `write_in_flight` while the write is executing and changes nothing; in the
  settled→resume window it is a real `parked → cancelled` CAS racing resume.
  The Client settles only on Core's actual answer — never a local "stopped"
  over a write that may commit.
- **TickTick stays the sole authority.** Core stores the Proposal and its write
  state (decision provenance), never a task row: no task cache, no sync engine,
  no local queue or retry daemon. A created task is visible by re-reading
  TickTick. A created task can also exist yet fall outside the Tasks view's
  200-item page — the existing incompleteness banner covers that.
- **A failed write is a failed write.** No deferred delivery. The model is told
  to relay the outcome and, after an `unknown`, to have the user check TickTick
  before proposing again.
- **The read lanes did not change.** `EXTERNAL_READ_ALLOWLIST` is byte-identical
  and the read-lane tests pass unchanged; the reserved `ticktick_` prefix still
  rejects every Core tool registration, and the new proposal tool deliberately
  does not wear it (it renders as a Proposal card, never an external row).
- **Prompt-injection posture is unchanged in kind.** A hostile read result can
  at worst make the model *propose*; the card shows exactly what will be
  written; nothing writes without a human accept. One Tool Request = one
  Proposal = one Decision still holds, so "create 500 tasks" parks once and the
  siblings are never read.

## Considered and rejected

- **A 13th `ProposableMutation` kind** instead of a dedicated tool. Rejected:
  `ProposableMutation::ALL` IS the `propose_workspace_mutation` descriptor's
  `oneOf`, so a new kind is model-visible the moment it exists (no ship-dark
  path), a remote write with a three-valued outcome is not a "Workspace
  mutation," and the TickTick-specific guidance belongs in the tool description
  the model reads.
- **Executing the write inside decide's atomic transaction.** Rejected: it
  holds a SQLite write tx open across a network call and makes crash recovery
  indistinguishable from a rollback.
- **A local queue / retry daemon for failed writes.** Rejected: without an
  idempotency contract a retry can duplicate a task the user experienced as one
  accept. The human is the retry mechanism.
- **A timeout combinator around the POST inside the decide task** instead of an
  independent watchdog. Rejected: a panic or abort in phase B would kill the
  deadline with it and strand the row `executing` until a restart — exactly the
  failure the watchdog exists to remove.
- **An inline (socket-blocking) decide.** Rejected: Core's per-connection loop
  awaits each dispatch and owns outbound sends in the same `select!`, so an
  inline A→C decide would freeze the connection both directions for up to the
  request timeout — other Runs' event tails would stall and a same-socket Stop
  could never arrive during the write. The family's decide runs detached and
  replies by request id.
- **A boot-scoped connection-ID snapshot** as the staleness guard. Rejected:
  the connection id is random per boot by design, so every restart would
  permanently strand every parked write Proposal.

## Related

- [ADR-0064](./0064-task-ownership-moves-to-ticktick.md) — made TickTick the
  sole authority and removed task writes; this ADR restores create, only.
- [ADR-0025](./0025-proposal-park-and-resume.md) — the park/decide/resume
  machinery this extends with a sibling accept envelope; its
  validation-ordering lesson (checks on the fresh apply path, after
  replay/recovery) is applied to the edited payload here.
- [ADR-0016](./0016-proposal-application-policy.md) — one write path per
  Proposal; the auto-approve mechanism this family is barred from.
- [ADR-0033](./0033-user-initiated-entity-crud-writes-directly.md) — the
  full-document replace doctrine the card's edit follows.
- `docs/plans/ticktick-writes-plan.md` — the converged plan (W-A1…W-A8) and the
  W1 write-contract findings this ADR is the durable record of.
