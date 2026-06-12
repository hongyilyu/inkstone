# ui-sdk design notes

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## packages/ui-sdk/src/index.ts — proposalQueue (WsClientLive)

One shared queue carries all `proposal/*` notifications (ADR-0025); the UI reads
them via `proposalNotifications()`. It is created lazily so a Client that never
subscribes pays nothing.

## packages/ui-sdk/src/index.ts — socket (WsClientLive)

Built on `@effect/platform`. `makeWebSocket` only constructs the Socket value;
the connection is established when `runRaw` runs. The `WebSocketConstructor`
(browser/global `WebSocket` — present in Node 26 and the browser) is provided
internally so the public layer signature stays
`Layer<WsClient, never, WsClientConfig>` (no `R` leak).

## packages/ui-sdk/src/index.ts — failPending (WsClientLive)

On a drop, every in-flight request is failed with a typed `connection_lost`
error and the pending map is cleared. There is no resubscribe-replay: `runQueues`
persist (a future re-subscribe reuses the queue) but `run/subscribe` is NOT
auto-resent — stream recovery is slice-13 hydration's job.

## packages/ui-sdk/src/index.ts — hasOpened / first-open defect (WsClientLive)

Open failure stays a defect (ADR-0020): the layer cannot construct. The first
successful open is tracked; only AFTER it has opened once is a disconnect treated
as recoverable and bounded-retried.

## packages/ui-sdk/src/index.ts — connection (WsClientLive)

One connection lifetime. `runRaw` resolves only when the link ends (clean close
=> success; read/open/abnormal close => failure). Either way the connection is
gone, so it is failed uniformly to drive retry.

## packages/ui-sdk/src/index.ts — supervised retry (WsClientLive)

On every drop, fail in-flight requests, then bounded-retry the reconnect.
`while: hasOpened` ensures a FIRST-open failure is NOT retried (it propagates so
the layer build can die); only mid-session drops reconnect. Capped at 5 attempts
with exponential backoff.

## packages/ui-sdk/src/index.ts — subscribeRun (WsClientLive)

`subscribeRun` is request-driven (pure-subscribe): send `run/subscribe`, await
its correlated response, THEN stream the run's events from the per-run queue. The
queue is created before the request is sent so any `run/event` notifications that
arrive after the ack are captured.
