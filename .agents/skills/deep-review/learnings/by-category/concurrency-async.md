# Learned rules — Concurrency & async (`concurrency-async`)

_16 rules. Loaded by the `dr-concurrency-async` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Revalidate target before applying a late async result  ·  `guard-stale-async-result-before-applying`
- **Severity:** blocking  ·  **Support:** 5  ·  **Seen in:** #23407, #30722, #31095, #31208, #32331
- **Rule:** When an async result (.then/await) is written into shared state, a keyed store, the DOM, or a global flag, require a guard checked AFTER the await confirming the target is still current before applying: compare a generation/epoch/navigation token captured before the await, re-check key existence, or check a disposed flag / element.isConnected. Only flag when the awaited value is applied to mutable shared/external state AND the target can plausibly be removed, unmounted, or superseded between op start and completion; do not flag pure local computations or results assigned to a fresh local variable.
- **Detect:** In a changed hunk, find a .then/await callback that writes to a keyed store, signal/state, tree, error flag, or DOM property (e.g. img.src). Ask: between starting this async op and applying its result, could the target have been removed, replaced, unmounted, or superseded by a newer request? Is there an existence/version/disposal guard (token !== current, isConnected, disposed flag) before the write? If none, flag it.

## Bound async handshakes and network fetches with a timeout  ·  `bound-async-waits-with-timeout`
- **Severity:** blocking  ·  **Support:** 4  ·  **Seen in:** #54, #4913, #25962, #29446
- **Rule:** Flag an awaited external operation that may never settle and has no timeout/AbortSignal: (a) `await new Promise` waiting on a child-process `message`/`ready`/`spawn` event with no timer or abort in the executor (kill child on timeout); (b) when a PR adds `signal:`/AbortController to some `fetch(` calls, sibling `fetch(` calls in the same flow (especially auth/token endpoints) left without one. Skip operations already bounded by an upstream timeout or a library default.
- **Detect:** Find `await new Promise(... child.on('message'|'ready'|'spawn' ...))` with no timer/AbortSignal in the executor — ask: if the subprocess never posts ready or error, does this ever settle? Also: when a PR adds an AbortController/`signal:` to some `fetch(` calls, grep the same module for other `fetch(` calls lacking `signal:`; flag unprotected auth/token fetches.

## Do not leave fire-and-forget promises unhandled or untracked  ·  `handle-fire-and-forget-promise-rejections`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #13224, #25516, #28420, #31192
- **Rule:** Flag a discarded promise-returning call whose rejection is not handled AND whose completion is mis-tracked: (a) `void p()` with no `.catch`; (b) an `async` function passed to a sync callback slot the framework invokes without awaiting (wrap in an IIFE with try/catch); (c) an inner promise not returned from a `.then` so an outer `.finally`/busy-flag settles early; (d) an optimistic state setter followed by a swallowed `.catch(()=>{})` with no rollback or logging. Do not flag intentional fire-and-forget that already logs/handles errors, or test/throwaway scripts.
- **Detect:** Grep for `void \w+(`, `.catch(() => undefined)` / `.catch(() => {})` with no rollback or logging, and `async () =>` assigned to an event/command callback invoked as `cb?.()`. For `.then` callbacks that themselves start a promise, check whether that promise is `return`ed before any outer `.finally` that resets state. Ask per hunk: are this discarded promise's rejections handled, and does completion tracking reflect the true async completion?

## Serialize or make atomic any read-modify-write on shared state  ·  `atomic-shared-state-mutation-no-toctou`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #135, #2910, #27053, #28434
- **Rule:** Flag a check-then-write or read-modify-persist on a resource reachable by concurrent actors (a file/record shared across processes, or a module/instance-level Set/Map/array mutated then persisted from concurrently-invoked code) with no atomicity between read and write — lock, exclusive-create+rename, transaction, CAS, or atomic Ref. Only flag when concurrent invocation is actually plausible (shared file, server request handler, multiple fibers); skip single-threaded init or request-local state.
- **Detect:** Look for read -> conditional status/state check -> mutate same field -> write-back on a shared file/record with no lock/flock/transaction/CAS between read and write (especially fields named status/state/claimed/locked), or read-modify-write of a module-level collection followed by a persist call (fs.writeJson/writeFileString) reachable from multiple fibers/callers. Ask: can two concurrent actors both pass the check and both write?

## Scope and reset one-shot recovery/retry guards  ·  `reset-one-shot-recovery-retry-guards`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #379, #25710
- **Rule:** Flag `if (flag) return; setFlag(true); <recovery/retry/init action>` where the guard is set true but is never reset anywhere on success, context change, or failure — permanently disabling later legitimate attempts. Prefer per-entity guards (Set of ids) reset appropriately. Do not flag intentional once-per-process initialization where re-running is genuinely undesirable.
- **Detect:** Flag `if (flag) return; setFlag(true); <recovery/retry action>` where the flag is set true once but is never reset anywhere in the module. Ask: do subsequent legitimate retries get silently skipped forever?

## Make timing-sensitive broadcast events recoverable by late/reconnecting subscribers  ·  `ephemeral-broadcast-events-must-be-recoverable-by-late-subscribers`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #89, #120
- **Rule:** Events published onto a broadcast channel before a subscriber can attach are dropped (broadcast has no replay to late subscribers). If a producer can run before the client gets the id needed to subscribe, or a subscriber attaches after a terminal event was already published, an important event (started indicator, terminal status) is silently lost. Either persist such events into the snapshot late subscribers replay, buffer until a subscriber attaches, or — when reading a snapshot whose status is already terminal — emit a synthetic terminal event instead of tailing a channel that will never deliver one.
- **Detect:** tx.send(...)/broadcast publish marked 'not persisted'/'won't replay' where the producer can run before the subscriber attaches; or tx.subscribe()/broadcast::Receiver created right after reading a status snapshot followed by a forwarder relaying only future events. Ask: if the status is already terminal or the event fired pre-subscribe, does any terminal/started event still reach this receiver?

## Attribute streaming deltas to the per-run message id/index, not the current last message  ·  `attribute-streaming-deltas-by-per-run-id-not-last-message`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #9, #133
- **Rule:** Track the assistant message index/id per runId and update that specific entry from the stream handler, rather than mutating the current last message (next[next.length-1] / messages.at(-1)). Assume runs can overlap unless the UI strictly prevents concurrent submits (composer disabled, onSend awaited) — otherwise late deltas from an earlier run land in the newest bubble when the user submits a second prompt before the first finishes.
- **Detect:** A streaming text_delta/event handler writes to arr[arr.length-1] to attribute streamed output. Ask: if two runs overlap, can a delta for run A be written to run B's bubble because it targets the last message rather than a per-run id/index?

## Guard shared-controller cleanup against overlap and test out-of-order completion  ·  `out-of-order-async-completion-tests-and-guarded-shared-controller-cleanup`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #112, #2910
- **Rule:** When a shared instance field tracks the current AbortController/process for an operation that can overlap, the finally cleanup must only clear it if it still equals the controller this run created (if (this._x === local) this._x = undefined), or track active runs with a counter/Set; an unconditional reset lets a stale finally corrupt a newer in-flight run. Single-slot fields tracking in-flight async work must also guard against starting a new one while the previous is unfinished. Tests for overlapping async operations must include an out-of-order completion case (start A then B, resolve B before A).
- **Detect:** finally { this._someAbortController = undefined } or this.someProcess = child assigned without checking a still-running previous; tests that only resolve concurrent deferreds in start order.

## Clear single-flight scheduler guards only after the callback completes  ·  `single-flight-guard-cleared-after-callback`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #26813
- **Rule:** Flag a flush/single-flight function that resets its in-flight guard (`scheduled=false` / `frame=undefined`) BEFORE invoking the queued callback, where the callback can call the schedule function again — risking a second concurrent flush loop. Require the guard stay set during execution (or a dedicated flushing flag) cleared only after the callback completes. Only flag when reentrant scheduling from the callback is actually reachable.
- **Detect:** Flag a scheduler that sets its `scheduled`/frame guard to undefined/false at the top of the flush function, then runs a queued callback that can itself call the schedule function. Ask: if the callback re-schedules synchronously, can a second concurrent loop start?

## Use cross-process-unique IDs for keys in a shared store  ·  `cross-process-unique-id-generation`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #27053
- **Rule:** Flag an ID generator combining Date.now()/timestamp with only a module-level per-process counter when the result keys files/records in a store that other processes also write to — collisions occur within the same millisecond across processes. Require a cross-process-unique source (crypto.randomUUID(), or timestamp+pid+randomness). Do not flag IDs scoped to a single process or used only as in-memory keys.
- **Detect:** Look for an ID generator combining Date.now()/timestamp with a module-level `counter` variable where the result is used as a filename/key in a directory other processes also write to. Ask: can two separate processes produce the same ID in the same millisecond?

## Register signal-forwarding handlers before spawning the child  ·  `register-signal-handlers-before-spawn`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #26259
- **Rule:** In code that spawns a child and forwards termination signals, flag `process.on('SIGINT'|'SIGTERM'|...)` registered AFTER the `spawn(...)` call — a signal arriving in the gap terminates the wrapper without forwarding, orphaning the child. Require handlers registered before spawn, exiting/re-raising safely when no child is assigned yet. Only applies when the handler's purpose is forwarding to the spawned child.
- **Detect:** Flag `process.on('SIGINT'|'SIGTERM'|...)` forwarding to a child that appears after the `spawn(...)` call. Ask: if a signal lands between spawn and handler registration, is the child orphaned?

## Lazy-initialize singleton/default rows atomically, not SELECT-then-INSERT on the pool  ·  `lazy-singleton-init-must-be-atomic`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #22
- **Rule:** Lazy get-or-create for a singleton/default row must be atomic: use a uniqueness constraint with INSERT ... ON CONFLICT DO NOTHING, or do the select-or-create inside a transaction with the right guarantee. A bare SELECT-then-INSERT on the pool lets two concurrent first-time callers both miss and both insert, producing duplicate rows that violate a single-row invariant.
- **Detect:** Code does SELECT ... LIMIT 1 then INSERT to mint a default/singleton row directly on the pool with no unique index. Ask: can two concurrent callers both miss the SELECT and both INSERT, breaking a single-row invariant?

## Read config/settings that seed transactional writes through the same transaction handle  ·  `read-tx-feeding-data-through-same-tx-handle`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #131
- **Rule:** Read any setting/config value that seeds data committed inside a transaction through the same transaction handle (&mut tx), so derived data comes from the same serialized snapshot you commit. Reading shared mutable state from the pool before pool.begin() and then using it to compute a field written inside the tx is a TOCTOU gap: a concurrent write can change the source between the read and the commit, persisting data derived from stale state.
- **Detect:** In an apply/commit fn, a value is fetched via pool (settings::xxx(pool).await) before pool.begin(), then used to compute a field stored inside tx. Ask: is there an await between this read and the commit where another task could change the read source?

## On exhausted reconnect/retry, fail in-flight and future requests instead of hanging  ·  `bounded-retry-must-fail-future-requests-not-hang`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #54
- **Rule:** When a bounded reconnect/retry loop gives up, put the client into a terminal failed state so in-flight and future request() calls reject with a typed error rather than enqueuing a pending deferred and awaiting a write nothing will fulfill. A dead receive/reconnect loop must not leave callers blocked with no path to completion.
- **Detect:** An Effect/promise retry has a finite times/maxAttempts; on exhaustion the fiber ends but request() still adds to a pending map and awaits. Ask: after retries are exhausted, what fails the in-flight and future requests? If nothing, they hang.

## Don't parallelize order-dependent shared-state mutation with Promise.all  ·  `keep-concurrent-registration-deterministic`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #4925
- **Rule:** Do not convert a sequential loop that mutates shared state into Promise.all when ordering/precedence matters (first-in-order wins for flag defaults, provider/extension registration). Concurrent factories racing on shared mutable state break deterministic precedence; keep registration sequential, or buffer per-item results and apply them in input order after all complete.
- **Detect:** A diff replacing `for (...) { await loadX(..., sharedRuntime) }` with `await Promise.all(paths.map(...))` where the callback passes the same shared mutable object and correctness depends on order.

## Drain buffered stream events before interrupting on cancel  ·  `drain-buffered-stream-events-before-interrupting-on-cancel`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #142
- **Rule:** When stopping a live subscription/stream by interrupting its consuming fiber, deltas already received over the wire but not yet drained from the transport queue are lost when you immediately apply a synthetic terminal event (the synthetic event settles status but cannot recover the undrained tail). The applied store text survives; only buffered-but-unprocessed events vanish, so the surface can show less than was persisted until a reload re-hydrates. For a still-running stream, prefer letting the real terminal event drain (or refetch an authoritative snapshot) before settling; reserve synthetic settlement for cases with genuinely no live tail (e.g. a parked/torn-down hub, or unknown_run where no event will ever arrive).
- **Detect:** A cancel/stop handler calls `interruptRun`/`fiber.interrupt()` then immediately `applyEvent({kind:'cancelled'})` (or setState terminal) for a Run/stream that may still have queued notifications. Ask: can committed-but-undrained deltas be lost, showing less text than persisted until reload?
