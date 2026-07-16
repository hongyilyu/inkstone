# web-store design rationale

Design rationale extracted from code comments during cleanup — keep in sync with the source.

## apps/web/src/store/chat.ts — store (zustand vanilla)

The store is a plain *vanilla* zustand store so the free action functions stay callable OUTSIDE React render — the bridge (`bridge.ts`) and hydration (`hydrate.ts`) drive these imperatively. The selector hooks wrap zustand's `useStore`, which is backed by `useSyncExternalStore`; returning stable references (e.g. `EMPTY_MESSAGES`) preserves selector identity across unrelated state changes. ADR-0020: Effect owns the wire; React state is plain (zustand, not `@effect/atom`).

## apps/web/src/store/chat.ts — loadThreadMessages

This does NOT arm a Run snapshot — arming is owned by `beginRunSubscription`, which the resubscribe (`startRunStream`) runs for the streaming message's Run. The armed record makes the resubscribe's FIRST `text_delta` (the cumulative snapshot) SET the text to the authoritative cumulative value in `applyEvent` — the hydrated partial text is just an initial paint that the snapshot then supersedes. The orchestrator (`hydrate.ts#hydrateThread`) owns the thread/get → load → resubscribe flow; this action only loads.

## apps/web/src/store/bridge.ts — bridge module

The thin imperative seam between Effect (which owns the wire/streams/runtime) and the plain React store. Per ADR-0020, the bridge forks the SDK stream on the runtime and pushes events into the store via `applyEvent`. No Effect React-binding lib; the store stays plain.

Structured cancellation (Q18 A′): each run's stream fiber is retained keyed by run id so it can be interrupted on unmount. A run's stream is bounded by `Stream.takeUntil` on the terminal set (`done`/`error`/`cancelled`), so on any terminal event the `runForEach` completes and the fiber finishes on its own — independent of the focused thread.

## apps/web/src/store/bridge.ts — startRunStream

Identity-aware cleanup (M2): on decide-resume, `interruptRun` deletes the old entry and `startRunStream` sets the new one BEFORE the interrupted old fiber's finalizer runs. A bare `fibers.delete(runId)` would then delete the NEW resume fiber's entry — leaving it untracked (unmount can't interrupt it; a second decide can't either, splitting the resume tail across two consumers). Deleting only when the map still points at THIS fiber makes a stale finalizer a no-op.

## apps/web/src/store/bridge.ts — sendNewThread

First-message path: no thread is focused yet, so mint one. `threadCreate` returns `{thread_id, run_id}` in a single round trip; we then focus the new thread, seed the same user + live-assistant pair as `send`, promote the assistant message onto the run, and fork its stream. Mirrors `send` but minting the thread first (the slice-11-deferred create-on-first-message path).

Because the thread id only exists once `threadCreate` resolves, the optimistic seed happens after the await (unlike `send`, which seeds into a known thread up front). If `threadCreate` itself fails, nothing was minted or seeded, so there is no orphaned bubble to mark — the user can retry.

## apps/web/src/store/bridge.ts — decideProposal

Decide a parked Run's Proposal (accept/reject/edit) and resume the Run. Flips the card to `deciding`, calls `proposal/decide`, then on success sets the decided status AND re-subscribes to the Run so the resume tail (parked → running → completed, ADR-0022 snapshot-then-tail) streams into the assistant bubble. A failed decide flips the card to `error` so the user can retry.

An `edit` carries the user's `editedPayload`; Core re-validates it and applies in one step (ADR-0025), so the resume tail behaves exactly like an accept. A decide already in flight short-circuits (no double-submit); the stale parked stream fiber is interrupted before re-subscribing so the resume tail has a single consumer.

Double-submit guard (M1): a decide already in flight short-circuits. Returning stops a fast double-click from firing a second `proposal/decide` that races behind the first — the Run un-parks after the first decide, so the second hits Core as `proposal_not_pending` and its catch would stomp an accept that actually succeeded with a spurious `error`. Retry from `error` is still allowed (only `deciding` short-circuits).

Stale-fiber guard (M2): a parked Run's forwarder closes with NO terminal event, so the original `subscribeRun` fiber (bounded by `takeUntil` on the terminal set) never completed and is still blocked on the per-run queue. Interrupt it BEFORE re-subscribing so exactly one consumer drains the resume tail — two consumers would split a multi-chunk continuation between them and corrupt the text. Re-subscribing then owns the snapshot boundary itself: `startRunStream` internally `beginRunSubscription`s, re-arming the record's cumulative-snapshot bit (`snapshotArmed`), so the resume's FIRST `text_delta` — again the cumulative snapshot, re-including any pre-park prose — SETs the authoritative cumulative text; appended, it would duplicate the on-screen prefix (the M1 bug).

## apps/web/src/store/hydrate.ts — toMessage

Map a wire `MessageView` to the live `Message`, narrowing the wire `role`/`status` STRINGS to the live literal unions WITHOUT casts. The wire schema types both as `S.String` (packages/protocol), but Core only ever emits the known values. We narrow defensively via explicit guards: an unknown role defaults to `assistant`, an unknown status to `completed` — so a malformed frame paints as a finished assistant bubble rather than crashing or leaving a phantom streaming row.

An `incomplete` turn whose owning Run's `terminal_reason` is `'cancelled'` additionally sets the store's `cancelled` flag (ADR-0014: cancel is not an error, so the turn rehydrates as the calm stopped notice, not the failure alert). The `incomplete` guard is load-bearing: a cancelled Run's *user* Message also carries the reason on the wire but is `completed`, and must never be flagged. Any other reason (`errored`, `worker_disconnected`, `core_restarted`) — or no reason — leaves `cancelled` absent, keeping the failure alert.

## apps/web/src/store/hydrate.ts — hydrateThread

Hydrate a thread from `thread/get` and resume any streaming run (slice 13).

Reactive status (issue #108): hydration drives a per-thread `hydration: "loading" | "ready" | "error"` field on `ThreadState` (the `useHydrationStatus` selector + `setHydrationStatus` action in `chat.ts`), which replaces the old non-reactive `hydration-set.ts` Set. `hydrateThread` sets `loading` BEFORE the await, then settles to `ready` on success or `error` on a failed `threadGet`. This is the signal that lets `ChatColumn` show a recoverable error instead of an eternal skeleton, and it gates re-hydration: `useHydrateFocusedThread` fires only when status is `undefined` (never-hydrated), so a settled `error`/`ready` is not auto-re-fetched — a failed thread is retried only by the user via the error affordance.

Flow: set status `loading` → run `threadGet(threadId)` on the runtime → map the wire messages to live `Message`s → `loadThreadMessages` → for every message with `status === "streaming"` AND a non-empty `run_id`, `startRunStream` to resubscribe (arming the record's snapshot bit via `beginRunSubscription`, so the resubscribe's first cumulative `text_delta` SETs the text) → settle status `ready`.

On failure (`WsError`) the effect's success branch never runs, so nothing is loaded and status settles to `error` (unless a send made the thread live mid-fetch — see became-live below — in which case it settles `ready`). Not a throw; the returned Promise always resolves. (`App.test` focuses no thread, so hydration never fires there regardless.)

Became-live handling: the composer stays live under the loading skeleton, so the user can `send` into this thread DURING the in-flight `threadGet`. That seeds an optimistic user+assistant turn and (via `attachRun`) an `activeRunId`. An unconditional `loadThreadMessages` full-replace would then wipe the seeded turn AND orphan its streamed reply (the assistant message id the live `applyEvent` targets disappears). So when the thread became live we NON-destructively `prependHistory` the fetched (older) turns in front of the live turn instead of replacing — preserving prior conversation without clobbering the in-flight one — and skip resubscribing (the live turn already owns the active run; the fetched history is settled). A `threadGet` that FAILS after the thread became live still settles status to `ready` (not `error`): the live turn is valid content, so we must not paint an error over it.
