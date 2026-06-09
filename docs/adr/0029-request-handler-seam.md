# Request handlers are `Result<S, HandlerError>` bodies behind one framing combinator

Core's JSON-RPC request handlers (the `run/*`, `thread/*`, `entity/*`, `proposal/*`, `provider/*`, `settings/*`, `model/*` methods dispatched in `runs/mod.rs`) are written as **fallible bodies** — `async fn(deps, P) -> Result<S, HandlerError>`, where `P` is the decoded params, `S: Serialize` is the success value, and `HandlerError` is a typed enum. A single **combinator** owns everything around the body: decode `req.params` into `P`, run the body, frame `Ok(s)` as a JSON-RPC Response, frame `Err(e)` as a JSON-RPC error, and log internal failures. `HandlerError` carries its own JSON-RPC `code` (the enumerated vocabulary of [ADR-0014](./0014-client-core-wire-protocol.md)) and its own client-facing message, so the mapping from failure to wire-code lives in **one place** rather than at each call site. The four error framers in `runs/reply.rs` (`send_error`, `send_invalid_params`, `send_unknown_thread`, `send_proposal_not_pending`) collapse into the one shared `send_rpc_error` keyed by `HandlerError::code()`.

UUID-bearing params are typed as `Uuid` **at decode** (not `String` parsed inside the body): a malformed id is a decode failure, which the combinator frames as `invalid_params` (`-32602`) uniformly, before the body runs. The wire is unchanged — ids stay JSON strings ([ADR-0009](./0009-protocol-strategy.md)); only Core's Rust decode is typed and therefore stricter.

## Scope

The ~12 **request→response** methods, the ones whose whole job is "one request in, one Response out":

`run/post_message`, `run/cancel`, `thread/create`, `thread/list`, `thread/get`, `entity/list_todos`, `proposal/get`, `provider/status`, `model/catalog`, `settings/get`, `settings/set`, `provider/login_start`.

Two methods are **deliberately out** (see below): `run/subscribe` and `proposal/decide`.

`HandlerError` variants and their [ADR-0014](./0014-client-core-wire-protocol.md) codes:

- `InvalidParams(String)` → `-32602` — also the target of every decode failure (missing field, wrong type, malformed UUID).
- `UnknownThread(Uuid)` → `-32001`.
- `ProposalNotPending(String)` → `-32002`.
- `ProviderLoginFailed(String)` → `-32003` — a provider login could not start/complete; carries a sanitized, user-facing message (helper output, or "already in progress").
- `Internal(anyhow::Error)` → `-32603` — full detail logged to stderr, **generic** message to the client.

## What is a protocol error vs a result value

`HandlerError` is for **protocol** errors — the request was malformed, named a missing entity, or Core faulted. Domain outcomes that are negative-but-expected stay in the `Ok` payload: `run/cancel` returns `accepted | already_terminal | unknown_run` as its **result** ([ADR-0014](./0014-client-core-wire-protocol.md) §Cancellation models these as result values, not error codes), and `run/post_message`'s unknown-thread *is* a protocol error (`UnknownThread`). The combinator does not flatten this distinction: a body chooses its channel — `Ok(outcome)` for a domain result, `Err(HandlerError)` for a protocol error.

## Why a combinator, not a handler trait or a router framework

The 12 methods are statically known and live behind one loopback WebSocket ([ADR-0014](./0014-client-core-wire-protocol.md)). A generic higher-order function (`handle<P, S>`) monomorphizes per method — zero-cost, each handler stays a plain `async fn`, and the dispatch `match` in `runs/mod.rs` stays a readable table. A `trait Handler` + `dyn` registry, or an extractor/router framework in the shape of axum/tower, would add runtime dispatch and a registration concept to buy flexibility nothing here needs — the indirection-without-leverage [ADR-0026](./0026-worker-transport-seam.md) is wary of. If a method count or a middleware need ever justifies a router, the combinator does not preclude one; none is built now.

## What stays out (deliberately not wrapped)

`run/subscribe` and `proposal/decide` are not request→response and do not fit a one-Response combinator:

- **`run/subscribe`** is *snapshot-then-tail* ([ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md)): it sends a Response, then a snapshot `text_delta`, then **spawns a forwarder** that streams the live tail (with gate-exact delivery, lag re-snapshot, connection-drop detection, and a synthesized-`done` guarantee). It emits many frames over time, not one Response.
- **`proposal/decide`** ([ADR-0025](./0025-proposal-park-and-resume.md)) is an idempotent, multi-step transaction: validate, apply/reject, possibly **resume** the parked Run (respawn a Worker), and push `proposal/changed`. Its retry-safety and side-effects are not a `Result<S, _>`.

Both still benefit from the typed-id decode: their params are `Uuid`-typed like the rest, so a malformed id fails at decode.

**Refinement — `proposal/decide` stays out of the combinator but gets its own deep interface.** Out of the combinator is not the same as hand-rolled. The transaction moves into a deep `crate::decide` module: `decide::apply(pool, proposal_id, decision, edited_payload, idempotency_key, resume) -> Result<DecideOutcome, DecideError>`, where `DecideOutcome` is `Accepted{run_id, entity_id}` / `Rejected{run_id}` and `DecideError` carries the negative outcomes — `LostRace` (the guarded-flip-lost race, was `db::ApplyError::NotPending`), `NotDecidable` and `Invalid` (collapsing to `-32002` / `-32602` on the wire), and `Internal`. The module owns idempotency, the guarded apply/reject, and the resume + still-parked recovery as **one** path — collapsing the two duplicated recover-then-resume copies the hand-rolled handler carried. `runs/proposal.rs::handle_decide` becomes a thin shell — decode → `decide::apply` → map `DecideError`→`HandlerError` at a **single** framing site → push `proposal/changed` — so the one-framing-site discipline the combinator gives the wrapped methods now holds here too, by hand. The resume step is injected as a closure (`worker::resume` in production) so `decide` takes no dependency on the `worker` subsystem and its logic is assertable as a value against a `:memory:` pool. `run/subscribe`'s body stays hand-written.

## Why type ids at decode, not parse them in the body

A handler that parses its own id (`Uuid::parse_str` → reply on failure) must *remember* to do so and to pick the right error code — and the codebase already drifted: `run/subscribe` framed a malformed `run_id` as `-32603` internal where every other handler used `-32602`, and `runs/mod.rs::dispatch` silently dropped malformed params in 7 of its arms while replying `invalid_params` in 2. Typing the id at decode makes a malformed id unrepresentable past the decode step, so the drift is closed by construction and every method — wrapped or not — answers a malformed id with `-32602`.

The trade-off, recorded honestly: the param structs in `crates/core/src/protocol.rs` now carry `Uuid` fields, slightly diverging from a pure wire mirror; and a decode-level UUID failure produces serde's message, blander than the hand-rolled `invalid thread_id "xyz"`. A body-returned `InvalidParams` keeps its specific message; a decode-failure `InvalidParams` does not. Accepted: the uniformity and the impossibility of skipping validation outweigh a per-field message, and Core is the authority that may reject malformed input strictly ([ADR-0002](./0002-clients-talk-only-to-core.md)).

## Why generic client messages for `Internal`

Today a DB failure sends the client `"get_thread_with_messages: {e}"` — a function name and raw SQL error over the wire — and separately `eprintln!`s. Routing all framing through the combinator makes the policy single-sourced: `Internal(e)` is **logged in full** server-side (the one site that replaces ~33 copied `eprintln! + send_error` pairs) and returns a **generic** message to the client. The client cannot act on Core's internals, and leaking them is a habit worth not forming.

The rule is precise: **`Internal` is for faults whose detail would leak** (SQL, function names, IO errors). Every *other* variant carries a sanitized, user-facing message via `Display` — `InvalidParams`, `UnknownThread`, `ProposalNotPending`, and `ProviderLoginFailed`. A provider-login failure is the instructive case: the Provider Helper's error text is already sanitized for display and is actionable ("login failed: …", "already in progress"), so it is a named domain error (`-32003`) that keeps its message, **not** an `Internal` collapsed to "internal error". Genuine operational faults in the same handler (helper spawn failure, no stdout, IO read error) stay `Internal` (PR #105 review).

The combinator's success path is also non-panicking: a result that fails to serialize is framed as `Internal` (`-32603`), not `expect`-panicked, so one bad `Serialize` cannot tear down the connection task (PR #105 review).

## Consequences

- `runs/reply.rs` keeps `send_response`, `send_rpc_error`, and the **notification** framers (`send_run_event`, `send_text_delta`, `send_proposal_pending`, `send_proposal_changed`); the four typed *error* framers collapse into `HandlerError::code()` + `send_rpc_error`.
- Each wrapped handler shrinks to its unique body; the decode/validate/frame/log spine exists once.
- **Behavior change:** `run/subscribe` answers a malformed `run_id` with `-32602` (was `-32603`), and `dispatch` no longer silently drops malformed params for any method — a malformed request is uniformly `invalid_params`. `Internal` client messages become generic. Integration tests in `crates/core/tests/` asserting the old code or a leaked message string are updated.
- **No `packages/protocol` change.** Ids stay JSON strings on the wire; the TS Schema is untouched. Valid ids round-trip identically (a Rust `Uuid` serializes to the same string), so the [ADR-0009](./0009-protocol-strategy.md) contract holds; Core's decode is intentionally stricter than the TS encoder.
- The combinator's dependencies (`pool`, `hubs`, `out_tx`) stay **plain arguments** — in-process per [ADR-0026](./0026-worker-transport-seam.md)'s stance; no `trait`, no port. The combinator and `HandlerError` mapping are unit-tested directly with a fake request and a body closure — the first unit coverage of Core's framing and error-mapping, which were previously reachable only through full integration tests.
- Reversal cost is re-scattering decode, framing, and the error-code choice back across the handlers; recorded as load-bearing rather than provisional.

## Considered and rejected

- **Validate ids inside each body (C1).** Keeps `protocol.rs` a pure wire mirror and preserves per-field messages, but leaves the error-code choice in every handler — exactly what drifted. Rejected: the guard belongs at decode, not in 12 places that must each remember it.
- **Wrap all 14 methods, including `run/subscribe` and `proposal/decide`.** Rejected: they are streams / idempotent multi-step transactions, not one-Response calls; forcing them through the combinator would either break their shape or bloat it with streaming and idempotency concerns they alone need.
- **A handler `trait` + `dyn` registry, or a router/extractor framework.** Rejected: runtime dispatch and a registration concept for 12 statically-known methods on one socket — indirection without leverage ([ADR-0026](./0026-worker-transport-seam.md)). The combinator stays a monomorphized HOF.
- **A separate "validated params" layer distinct from the wire structs.** A second type per method that the wire struct decodes into. Rejected: a type per method for little gain at this size; type the wire struct's id field directly.
- **Keep the per-handler `send_*` calls, only dedupe the UUID parse.** Rejected: leaves each handler choosing its error framer, so the drift stays possible.
- **Return Core's internal error detail to the client.** Rejected: leaks SQL and function names over the wire for information the client cannot use; full detail is logged server-side instead.

## Related

- [ADR-0014](./0014-client-core-wire-protocol.md) — the enumerated JSON-RPC `error_code` vocabulary `HandlerError` maps to; this ADR makes that mapping single-sourced, and honors `run/cancel`'s outcomes as result values, not codes.
- [ADR-0009](./0009-protocol-strategy.md) — hand-mirrored Rust↔TS types; typing Core's param ids as `Uuid` keeps the wire string unchanged and the contract intact.
- [ADR-0002](./0002-clients-talk-only-to-core.md) — Core is the authority; stricter decode and generic client errors follow from it.
- [ADR-0026](./0026-worker-transport-seam.md) — the in-process dependency stance (plain args, no `trait`, "indirection without leverage") the combinator follows; its "generic, not runtime DI" reasoning parallels "combinator, not `dyn` registry."
- [ADR-0022](./0022-run-event-delivery-hub-snapshot-tail.md) — why `run/subscribe` (snapshot-then-tail + spawned forwarder) stays out.
- [ADR-0025](./0025-proposal-park-and-resume.md) — why `proposal/decide` (park/resume idempotency + notifications) stays out.
