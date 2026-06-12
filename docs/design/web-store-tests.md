# web-store-tests

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## chat.test.tsx — makeStubRuntime

A stub `WsClient` backed by an in-memory `Queue` the test offers events to. This is the slice-10 `RuntimeProvider` injection seam: a runtime built from `ManagedRuntime.make(Layer.succeed(WsClient, stub))` (no real socket). Only `postMessage` + `subscribeRun` are exercised here; the rest never run.

## proposal.test.tsx — resume snapshot SETs after pre-park prose (M1)

Two distinct stream segments: the original parked subscribe and the resume re-subscribe each get a fresh queue (production opens a new hub per subscribe, so the resume's first delta is again the cumulative snapshot).

The original subscribe streams the pre-park prose. Its FIRST delta is the cumulative snapshot (SET), marking `snapshotApplied[run-1] = true` — exactly what production does on every first subscribe. The model streams prose, then parks on `propose_workspace_mutation` (NO terminal event, so the fiber stays blocked — this is the parked state).

After park + decide → resume re-subscribe, the resume snapshot RE-INCLUDES the pre-park prose (the cumulative text Core reconstructed) and then appends the closing line. The resume tail (on the FRESH resume queue): the first delta is the cumulative snapshot (re-including the prefix) → must SET, not append; the remaining deltas APPEND.

- SET (correct): the snapshot replaced the on-screen prefix.
- Append (the M1 bug): "Let me check the other thread. Let me check the other thread. Done — added it." (duplicated prefix).

## bridge.test.tsx — decideProposal resume fiber tracking (M2)

Accept → `interruptRun(old)` then `startRunStream(resume)`. The interrupted old fiber's finalizer fires asynchronously AFTER the resume fiber is set. Giving the stale finalizer its chance to run is the "clobber window": with the M2 bug it deletes the NEWLY-set resume fiber's entry; with the fix it is a no-op because the map no longer points at the interrupted fiber.

The resume fiber must still be tracked. With the M2 clobber the stale finalizer deleted the resume fiber's entry, so it would be untracked — a leak the app can never interrupt (and a second decide would split the tail across two consumers). The fix keeps it tracked.

## chat.selectors.test.tsx — reference stability

Regression guard for the Zustand migration (slice A): the selector hooks must keep returning a STABLE array reference across unrelated state changes. This is the property that lets `ChatColumn` bail out of re-rendering when an unrelated thread changes, and the property `useSyncExternalStore` / Zustand's `useStore` rely on (`Object.is` identity on the selector result). A selector that minted a fresh array on every read would fail these assertions — and under Zustand v5 would also trip the "getSnapshot should be cached" guard.

Written against the PUBLIC interface only (no internal imports).
