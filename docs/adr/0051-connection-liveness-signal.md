# Socket-liveness signal + unbounded reconnect

> **As-built amendment (removal) — the visible indicator is retired; the
> reconnect transport stays.** A pre-1.0 feature-cut sweep removed the
> always-visible `ConnectionStatusIndicator` from the `NavShell` footer, the
> `connectionStatus()` → zustand bridge fork, and the `useConnectionStatus`
> store. For a localhost single-user tool whose Core is a sibling child process,
> "connected" is near-always true, so a standing connected dot is ambient chrome
> the local-first-calm thesis (PRODUCT.md) does not need. **What this amendment
> does NOT touch:** the unbounded two-phase reconnect (the `SubscriptionRef`,
> `reconnectDelay`, `connected | reconnecting | disconnected` derivation) stays
> intact inside the `WsClient` Layer — the link still heals a dropped connection
> with no page reload. The `client.connectionStatus()` stream stays on the SDK
> interface (an untouched, tested seam a future surface can re-consume), and the
> per-send connection-failure copy (`connectionFailureCopy.ts`, which parses
> `WsError.reason`, never the ambient signal) is independent and also stays. If
> an ambient liveness surface is wanted again, re-mounting a component off the
> still-live `connectionStatus()` stream is a few lines — no transport rework.

The `WsClient` Layer exposes a **connection-liveness signal** —
`connected | reconnecting | disconnected` — derived purely from the socket
lifecycle it already owns (`onOpen` / per-drop `failPending` / retry cadence),
held in a `SubscriptionRef` and streamed to the Web Client as
`connectionStatus()`. The shell renders an always-visible status indicator off
it, and connection-caused send failures surface connection-specific copy. To
make a `disconnected` state recoverable **without a page reload**, the Layer's
bounded `times: 5` reconnect becomes **unbounded** (fast ramp → steady), so a
dropped link re-opens itself when Core returns.

This is the **first liveness signal** out of the transport layer. It is
**socket liveness**, NOT `provider/connected` (ADR-0049, OAuth-credential
state) — the two are independent and must not be conflated.

## Context

Core is a killable local process ([ADR-0007](./0007-local-first-single-user.md)),
so "is Inkstone running?" is a real recurring question. Today the link's health
is invisible:

- The `WsClient` Layer ([ADR-0020](./0020-effect-across-typescript.md))
  drops, fails in-flight requests with `connection_lost`, then bounded-retries
  the reconnect (`Schedule.exponential("50 millis")`, `times: 5`,
  `while: hasOpened`). After ~5 attempts (≈1.5s) the supervised fiber **fails
  silently — no consumer reads that terminal**. The UI looks normal while
  offline; a send blocks on the writer latch or fails with the generic
  "Couldn't send your message. Please try again." with no hint the real cause is
  a dropped connection. (Retired audit findings D07/D16 fixed per-action error
  copy but added no ambient connection surface.)
- The three socket transitions already exist as distinct points in the Layer:
  `onOpen` (re-fires on every (re)open), the `tapError(() => failPending)` arm
  (per-drop), and retry exhaustion. There is simply nothing observing them.

The Web Client validates against **t3code**, which built exactly this: a
transport-driven liveness state held in an Effect `SubscriptionRef`, bridged to
React, rendered as a status indicator + degraded banner
(`packages/client-runtime/src/connection/{supervisor,presentation}.ts`,
`apps/web/src/components/ChatView.tsx`). opencode and pi are negative results —
both infer health from a *decoupled* HTTP/timer poll (opencode
`server-health.ts`) or fire-and-forget retry events (pi `auto_retry_start`),
the staleness seam inkstone's in-Layer signal avoids.

## Decision

- **A `SubscriptionRef<ConnectionStatus>` inside the Layer scope, exposed as
  `connectionStatus(): Stream` via `SubscriptionRef.changes`.** `ConnectionStatus`
  is `connected | reconnecting | disconnected`. The ref is set at the three
  lifecycle points the Layer already owns: `connected` in `onOpen`, `reconnecting`
  when a drop enters the fast-ramp retry, `disconnected` once the fast ramp
  settles into the steady retry phase. `SubscriptionRef.changes` **replays the
  current value on subscribe** — the indicator mounts long after the socket opened
  (the shell renders per-route; the socket opens once at boot), so it needs the
  *current* value, not just future transitions. This is the property a
  `Queue`-backed stream (the `proposalNotifications()` pattern,
  [ADR-0025](./0025-proposal-park-and-resume.md)) lacks: a
  Queue delivers only future offers, so an indicator mounting after the last
  transition would render "unknown" indefinitely. A proposal is a discrete
  *event* (Queue-shaped); connection status is *state* (Ref-shaped). The
  `SubscriptionRef` is a new primitive but is **confined to the Layer** that
  already owns the socket; `.changes` hands the bridge a plain `Stream`, so the
  established Queue+zustand bridge pattern downstream is unchanged.

- **Reconnect becomes unbounded (two-phase), redefining `disconnected`.** The
  `times: 5` cap is removed. A drop retries forever: the existing ~50ms
  exponential ramp for the first handful of attempts (`reconnecting` — covers the
  common blip: laptop sleep, Core restart), then a steady ~5s interval forever
  (`disconnected` — "Lost connection to Inkstone. Retrying…"). `onOpen` re-fires
  on the successful re-open and drives the ref back to `connected`, so recovery is
  automatic with **no page reload**. `disconnected` therefore means "down a
  while, still retrying in the background," NOT "gave up" — there is no terminal
  give-up state anymore. `while: hasOpened` is retained: a **first-open** failure
  is still a defect that dies the layer build (ADR-0020), only *post-open* drops
  reconnect.

- **Always-visible indicator in the shared nav footer (`NavShell`), stream wired
  at `__root.tsx`.** `NavShell`'s footer row (account glyph + settings gear) is
  the one chrome shared by both the chat Sidebar and the Library nav, so an
  indicator there is visible on every authenticated route. It renders a quiet
  connected affordance (a small dot), morphs to a loading/spinner on
  `reconnecting`, and to a "Lost connection" treatment on `disconnected`. The
  *stream fiber* starts at `__root.tsx` (alongside `startProposalStream` /
  `setOnRunSettled`), mirroring the established bridge; only the visible element
  lives in the shell. Color is drawn from the existing palette (`muted` /
  `destructive`) — **no new `--warning` token** for a transient state — and is
  never the sole cue: an icon + `role="status" aria-live="polite"` region
  (inkstone's own `CopyOutcome` precedent) announces transitions, satisfying
  PRODUCT.md's "never encode meaning in color alone." Every reference repo is a
  *negative* example on a11y (color-only or `title`-only); this is the one place
  inkstone leads with its own pattern.

- **Connection-caused send failures parse `WsError.reason`, not the ambient
  signal.** `send()` / `sendNewThread()` already return `{ ok: false, error }`
  carrying the `WsRequestError` (`reason: "connection_lost"` from a dropped
  in-flight request, `"send_failed"` from a write on a dead socket); ChatColumn
  ignores `error` today. The handler inspects `reason` and shows
  connection-specific copy ("Inkstone may have lost its connection — check it's
  running") for those two reasons, falling back to the generic copy otherwise.
  The **error is authoritative for *this* send**; reading the ambient
  `SubscriptionRef` at catch-time races a concurrent reconnect (the socket may
  have just re-opened while this write already failed). The indicator and the
  per-send copy stay independent surfaces.

- **No Rust, no wire protocol, no parity gate.** The signal is derived purely
  from the client's own socket lifecycle. Adding a wire-level connection message
  is explicitly rejected (below).

## Considered and rejected

- **Queue-backed `connectionStatus()` mirroring `proposalNotifications()`.**
  Rejected for *this* signal: a `Queue.unbounded` + `Stream.fromQueue` delivers
  only future offers, so an indicator mounting after the socket opened shows
  nothing until the next drop — a healthy link renders as "unknown." Connection
  status is state, not a discrete event; `SubscriptionRef.changes` (current value
  on subscribe + changes) is the correct primitive. The Queue stays right for
  proposals precisely because a proposal has no meaningful "current value."

- **Keep bounded retry; recover via page reload.** The smaller change (reuse
  `main.tsx`'s crash-recovery `window.location.reload()`). Rejected per the
  product call: a local-first tool should heal a dropped link to a still-running
  (or restarted) Core on its own, without the user reloading. Unbounded retry is
  mechanically small — the Layer already re-runs `runRaw` on each retry (proven by
  the existing "bounded-reconnects so a fresh request succeeds" test); only the
  schedule changes.

- **An in-place `reconnect()`/`retryNow` effect on the `WsClient` interface**
  (t3code's `supervisor.retryNow`, manual button). Rejected for v1: with
  unbounded automatic retry there is no dead state to manually escape, so a
  Reconnect button has nothing distinct to do. Widening the `WsClient` interface
  (test-stub blast radius) is unjustified until a "retry now" beyond the
  automatic cadence is actually wanted.

- **A wire-level `connection` notification from Core.** Rejected: Core cannot
  notify the client that the client's own socket dropped (the link is gone). Socket
  liveness is a pure client-side derivation; a wire message would be both
  impossible for the drop case and redundant for the open case.

- **Gate `connected` on a first successful RPC** (t3code hardens `connected` to
  socket-open AND initial-config-RPC-success, so a half-open socket isn't reported
  healthy). Deferred: inkstone's `firstOpen` Deferred already approximates this at
  boot, and a heartbeat/probe watchdog (opencode's `resetHeartbeat`) is a
  follow-up if half-open sockets prove to be a real problem. v1 derives from
  `onOpen` directly.

## Related

- [ADR-0020](./0020-effect-across-typescript.md) — the `WsClient`
  Layer, `ManagedRuntime` + thin bridge, and the bounded-retry reconnect contract
  this **amends** (bounded `times: 5` → unbounded two-phase; the silently-failing
  terminal gains a consumer).
- [ADR-0025](./0025-proposal-park-and-resume.md) — the `proposalNotifications()`
  Queue-backed stream + `startProposalStream` bridge this signal's bridge mirrors
  (but uses a `SubscriptionRef`, not a Queue, for the reasons above).
- [ADR-0049](./0049-provider-connected-notification.md) — `provider/connected`
  (OAuth-credential state). Explicitly **distinct** from socket liveness; the two
  signals must not be conflated.
- [ADR-0007](./0007-local-first-single-user.md) — single-user local-first;
  Core is a killable local process, which is why ambient liveness matters.
