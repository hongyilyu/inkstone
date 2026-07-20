# Provider OAuth completion rides the connection-notification channel

When Core's detached credential-drain task persists the rotated OAuth
credentials, it **frames a `provider/connected {provider}` notification onto the
originating connection's `out_tx`** — the run-less channel ADR-0047 built. The
Web Client's app edge registers a by-method handler that **refetches**
`provider/status`, so the Settings → Models provider card flips to **Connected**
live, without waiting for the tab to regain focus.

This is the **second consumer** of the channel and the one ADR-0047 named as "the
strongest near-term sibling." It validates the channel's generic by-method
dispatch with a real second message that does not look like the first.

## Context

`provider/login_start` (ADR-0023, `provider.rs`) opens an OAuth flow and spawns a
**detached, non-Run task** that drains the login helper and persists the rotated
credentials AFTER the browser callback. Delivery of the *outcome* was lazy: the
handler's own doc said "the Client learns the outcome by re-querying
`provider/status` on focus." The card only flipped to Connected when the waiting
tab regained focus (`models.tsx` re-queries on `window` `focus`; the e2e
dispatched a synthetic `focus` and polled). That is the exact lazy-pickup gap
ADR-0047 closed for thread titles: a detached task finishes and the **waiting**
connection has no live signal.

## Decision

> **Client-mechanism amendment (2026-07-20).** The `setNotificationHandler` /
> `clearNotificationHandler` registry named below is superseded by the generic
> `WsClient.notifications(method, schema)` Stream member (and the `onNotification`
> React sugar) — see the **Amendment (2026-07-20)** in
> [ADR-0047](./0047-connection-notification-channel.md). Every *normative* decision
> here still holds (reuse the channel unchanged, refetch-not-patch, route-scoped
> registration/teardown, best-effort): `models.tsx` now registers via
> `onNotification("provider/connected", ProviderConnectedNotification, () =>
> refreshConnected())` and the SDK decode-drops a malformed frame at the
> subscription edge. Only the function names below are stale.

- **Reuse the ADR-0047 channel unchanged.** Core clones the handler's `out_tx`
  into the drain `tokio::spawn` (exactly as `thread_create` clones it into
  `spawn_title_generation`), and on the `Ok(Some(creds))` branch **after**
  `credentials::write` succeeds calls `reply::send_provider_connected`, a typed
  wrapper over the generic `reply::send_notification`. No `AppState` change, no
  global registry, no `dispatch`/handler-signature change, no new `handle_socket`
  select arm. The waiting app tab is the initiating connection — same-connection
  reach serves it, the channel's core assumption.

- **Wire shape `ProviderConnectedNotification { provider: string }`.** A
  Core-emitted notification crossing the contract-parity gate (ADR-0009
  as-built): Rust struct + TS Effect Schema + an `emitted` fixture + a registry
  entry, all atomic. The payload carries `{provider}` rather than a bare ping so
  a multi-provider future needs no wire change (today only `openai-codex`
  exists). It carries **only** the provider id — not the connection state.

- **The Client REFETCHES; it does not patch.** Unlike `thread/titled` — where
  the notification *is* the new truth (one title string, patched into the
  `["threads"]` cache in place) — `provider/connected` is a **ping**: the new
  `connected` state is richer truth living in Core's credential store, not in the
  message. So the handler calls the existing `refreshConnected()` (a
  `provider/status` round-trip), which is the right call here precisely for the
  reason ADR-0047 rejected refetch for titles. The login is single-flight
  (`provider.rs` `LOGIN_IN_FLIGHT`), so this fires at most once per connect — no
  refetch burst.

- **Registered route-scoped, in `models.tsx`** — NOT globally in `__root.tsx`
  like `thread/titled`. Provider status is read by local `useState` +
  `fetchConnected` on the Settings → Models route, not a globally-mounted query;
  the card only renders on that route, which is exactly where the user is when
  they click Connect. The handler is `setNotificationHandler("provider/connected",
  () => refreshConnected())` inside a route effect, torn down with
  `clearNotificationHandler("provider/connected")` on unmount. This + the
  always-mounted `thread/titled` handler are **two real consumers at two mount
  points**, neither clobbering the other — the validation that PR #210's
  method-scoped teardown (replacing clear-all) was the right primitive.

- **Best-effort / DB-is-truth, same contract as titles.** A dead `out_tx` (tab
  closed) makes the send a silent no-op; the focus-refetch in `models.tsx`
  remains the self-healing fallback. A failed/empty drain (`Ok(None)`/`Err`,
  helper exited without credentials) persists nothing, so it sends nothing — the
  card stays Not connected, correctly.

## Considered and rejected

- **Patch the card state from the notification** (mirror `thread/titled`'s
  in-place patch). Rejected: the push carries `{provider}`, not `connected`. The
  authoritative state is in Core's credential store; there is no local truth to
  splice. A refetch is the honest read. (This is the same trade-off as
  ADR-0047's title patch, evaluated and landing the *opposite* way because the
  data plumbing is opposite.)

- **Migrate provider status to a TanStack query + register in `__root.tsx`** (to
  literally mirror the title precedent's mount point and `invalidateQueries`).
  Rejected: it refactors currently-working imperative `useState`+`fetchConnected`
  code, and manufactures a global query key whose only consumer is this one push,
  for no user-visible benefit — the card only ever renders on the Settings route
  (§2 simplicity, §3 surgical). The route-scoped handler reuses the
  `refreshConnected()` seam already there.

- **A new typed SDK method / `WsClient` interface entry.** Rejected for the same
  reason ADR-0047 rejected a title-specific SDK stream: it rides the generic
  `setNotificationHandler` fallthrough, so the typed surface stays flat and there
  is no test-stub blast radius.

## Related

- [ADR-0047](./0047-connection-notification-channel.md) — the run-less
  connection-notification channel this consumes; it named provider OAuth
  completion as the strongest future consumer. This ADR is that consumer.
- [ADR-0023](./0023-provider-oauth-core-owned-credentials.md) — Core-owned
  credentials + the `provider/login_start` drain task whose lazy "learn on focus"
  delivery this completes (the focus-refetch is retained as the fallback).
- [ADR-0009](./0009-protocol-strategy.md) — the wire protocol + contract-parity
  gate the new notification crosses.
