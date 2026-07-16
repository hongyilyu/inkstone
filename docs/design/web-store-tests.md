# web-store-tests

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## chat.test.tsx — makeStubRuntime

A stub `WsClient` backed by an in-memory `Queue` the test offers events to. This is the slice-10 `RuntimeProvider` injection seam: a runtime built from `ManagedRuntime.make(Layer.succeed(WsClient, stub))` (no real socket). Only `postMessage` + `subscribeRun` are exercised here; the rest never run.

## run-record.test.tsx — resume snapshot SETs over the pre-park prefix (M1)

The snapshot SET-vs-APPEND scenario is pinned at the store level, on the Run record's `snapshotArmed` bit: `beginRunSubscription` arms it, the FIRST `text_delta` SETs the cumulative snapshot and clears it, the rest APPEND — no caller threads a flag. The M1 case parks the Run on a Proposal, then resumes through the SAME begin verb: re-arming makes the resume's first delta — again the cumulative snapshot, RE-INCLUDING the pre-park prose — SET.

- SET (correct): the snapshot replaced the on-screen prefix ("Let me check. Done.").
- Append (the M1 bug): "Let me check. Let me check. Done." (duplicated prefix).

proposal.test.tsx keeps the bridge-level M1/M2 guards: the double-decide test (M1 — a second decide observing `deciding` short-circuits, so a fast double-click never stomps an accepted card with a spurious error) and the single-consumer resume test (M2 — decide interrupts the parked fiber before re-subscribing, so the resume tail's deltas are not split across two consumers). Its M1 resume flow gives each subscribe a fresh stub queue — modeling each subscribe's wire segment, not production plumbing (in Core a subscribe just attaches a receiver to the run's existing hub, and `WsClientLive` reuses one queue per run id) — while the M2 test deliberately shares ONE queue across both subscribes, so a leaked second consumer would split the tail's deltas and fail the concatenation assert; the resume's first delta is again the cumulative snapshot because Core's `run/subscribe` always emits it as the FIRST `text_delta` (ADR-0022 snapshot-then-tail).

## bridge.test.tsx — decideProposal resume fiber tracking (M2)

Accept → `interruptRun(old)` then `startRunStream(resume)`. The interrupted old fiber's finalizer fires asynchronously AFTER the resume fiber is set. Giving the stale finalizer its chance to run is the "clobber window": with the M2 bug it deletes the NEWLY-set resume fiber's entry; with the fix it is a no-op because the map no longer points at the interrupted fiber.

The resume fiber must still be tracked. With the M2 clobber the stale finalizer deleted the resume fiber's entry, so it would be untracked — a leak the app can never interrupt (and a second decide would split the tail across two consumers). The fix keeps it tracked.

## chat.selectors.test.tsx — reference stability

Regression guard for the Zustand migration (slice A): the selector hooks must keep returning a STABLE array reference across unrelated state changes. This is the property that lets `ChatColumn` bail out of re-rendering when an unrelated thread changes, and the property `useSyncExternalStore` / Zustand's `useStore` rely on (`Object.is` identity on the selector result). A selector that minted a fresh array on every read would fail these assertions — and under Zustand v5 would also trip the "getSnapshot should be cached" guard.

Written against the PUBLIC interface only (no internal imports).
