# Learned rules — Error handling (`error-handling`)

_26 rules. Loaded by the `dr-error-handling` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Do not swallow errors silently in catch/handler blocks  ·  `no-silent-error-swallowing`
- **Severity:** important  ·  **Support:** 7  ·  **Seen in:** #24, #71, #125, #25516, #27936, #28207
- **Rule:** Flag error handlers that fully discard a caught error on a consequential operation: empty `catch {}`, `catch (e) {}` with the binding never used, `.catch(() => {})`/`.catch(() => undefined)`. Such a handler should at least log (debug/warn) or report via telemetry while returning a safe fallback. Exempt cases where the comment or code clearly marks the swallow as intentional/benign (e.g. best-effort cleanup) — focus on registration/IPC/config/fire-and-forget calls whose failure changes behavior.
- **Detect:** Grep for `catch {}`, `catch (e) {}` with unused binding, `.catch(() => {})`, `.catch(() => undefined)`, or `Promise.resolve().then(...).catch(() => {})`. Yes/no per hunk: is the caught error logged/reported anywhere, or fully discarded? Heightened concern when `void` precedes a consequential async call or when the swallowed promise is a registration/config call.

## Error/timeout fallback must itself be non-throwing and valid  ·  `fallback-path-must-be-safe`
- **Severity:** important  ·  **Support:** 4  ·  **Seen in:** #27936, #29208, #31309
- **Rule:** In a catch/orElse/timeout/race fallback, flag operations that can themselves throw (JSON.parse, decodeSync, throwing constructors/parsers) or that yield a possibly-undefined value passed to a consumer expecting a concrete value (e.g. `.catch(() => cached)` where cached may be undefined). Prefer a precomputed safe default or non-throwing decode. Capture/validate the input once before the try rather than re-reading a possibly-malformed payload inside the catch.
- **Detect:** Inside a catch/orElse/timeout fallback, flag calls to throwing constructors/decoders (names with `Sync`, `decodeSync`, `parse`, `JSON.parse`), re-access of `event.data.<field>`, or returning a possibly-undefined value (e.g. `.catch(() => cached)` where `cached` came from `cache.match`) to a consumer expecting a concrete value. Ask: if this fallback throws or yields undefined, is there any handler?

## Wrap throwing parsers/decoders of external input in try/catch  ·  `guard-throwing-parsers-on-external-input`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #26262, #27053, #29208
- **Rule:** Any throwing parse/decode applied to external, persisted, or request-derived input (JSON.parse on file contents or request bodies, decodeURIComponent / new URL on request paths, throwing schema decoders like decodeSync) must be wrapped in try/catch or Effect.try and turned into a recoverable failure or clean error response (400/404). A single corrupt/truncated file or malformed request must not throw synchronously and crash the operation — especially when the read is piped through `.orDie` or sits inside a loop over many entries, where the bad entry should be skipped rather than aborting the batch.
- **Detect:** Find `JSON.parse(...)`, `decodeURIComponent(...)`, `new URL(...)`, or `*decodeSync*`/`*Sync(...)` applied to file-read results or request-derived values that are NOT inside try/catch or Effect.try. High priority when inside a loop over directory entries or piped through `Effect.orDie`, or inside a request/protocol handler. Ask: what happens on malformed input?

## Do not collapse non-throwing error responses into fake success  ·  `no-fake-success-from-error-response`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #125, #134, #25615
- **Rule:** For SDKs/clients that return errors in the response object rather than throwing, explicitly inspect `res.error`/`response.status` (or pass `throwOnError: true`) before mapping. Do not collapse an error response into a placeholder success value like `res.data?.text ?? "No response"`, which hides the real error from the caller.
- **Detect:** Flag `.then((res) => res.data?.<field> ?? "<placeholder>")` (or similar) where the response type includes an `error`/`status` field that is never inspected. Ask: are non-throwing error responses handled, or silently turned into a fake success?

## Distinguish fs error codes and build user-facing errors from known fields  ·  `distinguish-fs-error-codes-and-build-terse-errors-from-known-fields`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #120, #3955, #4133
- **Rule:** When catching filesystem errors, inspect error.code and map distinct cases (ENOENT/ENOTDIR -> not found, EACCES/EPERM -> permission denied) with a generic fallback rather than collapsing every failure into one message. More broadly, build user-facing error messages from a small set of known fields (message, code) instead of dumping a whole event via JSON.stringify, and surface errors via a structured errorMessage/stopReason field rather than synthesizing a fake assistant text content block.
- **Detect:** A catch around fs access/read with a single hardcoded message (File not found: ${path}) and no switch on error.code; new Error whose message includes JSON.stringify of a whole event; or content.push({type:"text", text:`Error: ${...}`}) in a catch branch where an errorMessage field is also set.

## Surface failures when relaxing fail-fast to continue-on-error  ·  `no-silent-fail-fast-relaxation`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #28780, #29208
- **Rule:** When changing a fail-fast operation into log-and-continue, or when a timeout/fallback resolves to a no-op (Effect.void/empty resolve), do not let the failure become silent if downstream code assumes success or completion. Either re-raise after logging to preserve prior semantics, or surface a structured warning/diagnostic the caller can act on, so a timeout/hang or unmet invariant leaves an observable trace rather than silently continuing as if the work completed.
- **Detect:** Diff a previously-unguarded effect/promise that gains a `.catch`/`catchCause` returning void/default, or grep for `timeoutOrElse`/`Promise.race` whose fallback is `() => Effect.void`/`() => undefined`/`resolve()` with no log/throw. Ask: did this previously propagate failure, and does the timeout/continue path leave any trace?

## Keep all fallible load steps inside the guarded try block  ·  `place-fallible-steps-inside-try`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #26401, #31208
- **Rule:** Place every fallible step (dynamic imports, wasm/asset resolution, etc.) inside the try block (or attach error handling to it) so all failures follow the function's declared/normalized error path instead of escaping as a raw defect. A `await import(...)` or asset-resolution statement positioned before `try {` that can throw must be moved inside the guard.
- **Detect:** In a loader with try/catch, check for `await import(...)`, dynamic `import(...)`, or asset-resolution statements placed before the `try {`. Ask: can this pre-try step throw, and would it bypass the function's declared error type?

## Roll back optimistic state when the async operation rejects  ·  `rollback-optimistic-state-on-failure`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #71, #25813
- **Rule:** When local/module state is updated optimistically before an async operation resolves, add a `.catch` (or await + try/catch) that restores the last known-good value on rejection, so state does not drift out of sync and subsequent steps don't compound from a value that never actually applied.
- **Detect:** Flag a state/module variable assigned a new value immediately before an async call whose `.then` handles success but has no `.catch` reverting the value on failure. Ask: if the call rejects, is the optimistic value rolled back?

## Register the full failure lifecycle, not just the happy-path terminal event  ·  `wire-full-failure-lifecycle`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #22, #25962
- **Rule:** When wiring observability/handlers for a long-lived resource, register the failure/error events alongside the success/exit event. For a forked subprocess, registering only `child.on('exit', ...)` is insufficient — also add `child.on('error', ...)` and platform crash hooks (e.g. Electron `app.on('child-process-gone')` filtered by service) so launch failures, crashes, and OOM are distinguishable from a clean exit and surfaced.
- **Detect:** When a diff adds `child.on('exit', ...)` for a forked process, check whether `child.on('error', ...)` and crash hooks are also registered. Ask: are crash/launch-failed events handled, or only clean exit?

## Narrow each catch to the smallest block whose failure mode it handles  ·  `narrow-catch-scope`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #135, #29208
- **Rule:** Flag a try/catch or .catch/catchCause whose guarded block performs multiple semantically distinct fallible operations (e.g. parse + schema validation + plugin resolution + IO write-back) but whose recovery treats them as one error class — so an IO or resolution error is silently handled by a parse-error fallback. Recommend narrowing the catch to the block whose failure the fallback actually targets. Do not flag when all operations share the same legitimate recovery semantics.
- **Detect:** Look for a try/catch or `.catch`/`catchCause` whose guarded block contains multiple distinct operations. Ask: does the recovery logic treat all of them as the same error class? Flag if a parse-error fallback also swallows IO or resolution errors.

## Route serialization failures in the success path through error framing, not panic  ·  `do-not-panic-while-framing-a-successful-result`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #105, #4904
- **Rule:** Don't panic while framing a successful result. Match on the Result from serde_json::to_value (or other fallible serialization) and route the Err through the existing error-framing path (frame_error/HandlerError::Internal) so serialization faults degrade to a proper internal-error response and preserve handler availability instead of tearing down the task.
- **Detect:** Grep in handler/reply code for `serde_json::to_value(...).expect(` or `.unwrap()` on a to_value/serialize call in a non-test path. Ask: if serialization fails here, does the task panic instead of returning an error frame?

## Set hydrated/loaded flags only after the async load succeeds  ·  `set-hydrated-flag-only-after-async-load-succeeds`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #41, #122
- **Rule:** Set 'hydrated'/'loaded' flags only after the async load succeeds, not before. Marking success up-front, swallowing the rejection, plus a 'skip if already hydrated' guard means a transient failure permanently prevents retry and strands the resource empty. Relatedly, when a post-await guard detects a concurrent live update, merge/prepend the non-overlapping fetched items rather than discarding fetched history entirely (which is also unrecoverable since the thread is already marked hydrated).
- **Detect:** A fn calls mark*Hydrated/markLoaded at the start before awaiting the fetch, with a sibling guard skipping hydrated ids and caught/ignored errors; or a post-await `if (live?.activeRunId !== undefined || live.messages.length>0) return;` discards fetched result. Ask: is the flag set before the load can fail, blocking retry, or is fetched data dropped with no retry?

## Don't discard the flush error after writing a required handshake/manifest line  ·  `do-not-discard-flush-error-on-required-write-path`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #102, #1723
- **Rule:** Don't discard flush errors on a write path the peer depends on. After write_all of a required first line (handshake/manifest), check the flush Result and propagate the error on failure (log + Err), matching the write_all error handling — a swallowed `let _ = stdin.flush().await;` can leave data buffered and stall the peer waiting for input.
- **Detect:** Grep for `let _ = *.flush().await` (or unchecked .flush()) following a write_all of protocol/handshake data. Flag the discarded flush error.

## Handle rejection of lazy/dynamic imports that own a callback  ·  `handle-dynamic-import-rejection`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #31208
- **Rule:** A dynamic `import(...).then(...)` / `await import(...)` whose success branch opens a dialog/picker or otherwise owns a callback the caller is awaiting must handle import failure (a `.catch` or surrounding try/catch) and invoke the cancellation/error path (e.g. `onSelect(null)`), so a failed chunk load surfaces and the caller receives a result instead of hanging in a stuck state.
- **Detect:** Find `import(...).then(...)` or `await import(...)` with no `.catch` and no surrounding try/catch, particularly where the success branch opens a dialog/picker owning a callback. Ask: on chunk-load failure, does the awaiting caller still get a result?

## Use trailing .catch so mapping/normalization errors are also handled  ·  `catch-mapping-errors-not-just-rejection`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #31589
- **Rule:** Do not rely on the second argument of `.then(onFulfilled, onRejected)` as the only error handling when `onFulfilled` does non-trivial work (map/normalize/parse) — that only catches the original promise rejection, not errors thrown inside the mapping. Use `.then(map).catch(() => fallback)` so both the original rejection and mapping errors fall back.
- **Detect:** Flag `.then(onFulfilled, onRejected)` where `onFulfilled` performs map/normalize/parse work and the second arg is the only error handler. Recommend a trailing `.catch` after the mapping instead.

## Do not pass possibly-undefined credentials unconditionally into auth header builders  ·  `no-optional-creds-into-auth-builder`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #30571
- **Rule:** Attach auth headers only when credentials are actually present (or ensure the header builder returns empty/undefined for missing inputs), so requests don't carry malformed/incorrect Authorization headers built from undefined username/password/token.
- **Detect:** Flag a header/auth builder invoked with optional fields (`args.password`, `args.token`) without a presence check. Ask what the builder emits when those inputs are undefined.

## Preserve actionable client-facing error messages when refactoring error branches  ·  `preserve-actionable-error-messages-across-refactors`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #105
- **Rule:** When refactoring error branches, preserve actionable, already-sanitized client-facing messages. If a branch previously surfaced a specific failure reason to the UI (provider login failure), don't collapse it into a generic Internal variant whose framer emits only 'internal error' — use a variant that carries a client-facing message. Confirm which errors are user-actionable before mapping them to the catch-all.
- **Detect:** In a refactor diff, branches that previously sent a specific message now return HandlerError::Internal(...) (or equivalent generic error). Ask: did this branch lose a client-visible, actionable message the UI surfaces?

## Isolate an optional read from a shared batch fallback so its failure doesn't drop live data  ·  `isolate-non-critical-read-from-whole-batch-fallback`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #130
- **Rule:** Don't bundle an optional/non-critical async read into the same Effect.all/Promise.all batch whose shared try/catch falls back to stale/preview data — a failure in that one read drops ALL successfully-fetched live data. Wrap the non-essential read in its own catchAll/try-catch yielding an empty/default result so a transient failure doesn't invalidate the other successful reads.
- **Detect:** A diff adds an entry to an existing Effect.all([...]) / Promise.all([...]) wrapped in a single try/catch returning a fallback. Does the new element have its own Effect.catchAll/per-call error handling? If not, flag that one failing read collapses the whole batch.

## Validate normalized external/RPC content is non-empty before dispatch  ·  `validate-normalized-rpc-prompt-not-empty`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #125
- **Rule:** After normalizing external/RPC input into a prompt string, validate it is non-empty before dispatching; if all blocks were filtered out, return an explicit error to the client instead of silently calling prompt(""). Do not blindly String()-coerce untrusted content (which yields "null"/"undefined"/"[object Object]") and then silently drop it via a later typeof check; validate shape and report when a non-string value is encountered.
- **Detect:** promptText built via .filter().map().join().trim() || "" then agent.prompt(promptText) with no if(!promptText) guard; or String(x ?? "") on external content followed by .filter(c => typeof c.text === "string").

## Validate every referenced entity (source and target) before the FK write  ·  `validate-both-referents-before-fk-insert`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #135
- **Rule:** When an apply/mutation path inserts a row into a join/refs/association table that references two or more entities via foreign keys (e.g. entity_refs keyed on source_entity_id + target_entity_id), the pre-apply boundary validator must confirm EVERY referent exists (and is the right type) — not just one side. Validating only the target (or only the source) lets a missing/stale referent on the unchecked side trip the database FK at insert/commit and surface as an opaque internal/-32603 error instead of a client-correctable invalid-or-target-missing error. Detection: a validator runs entity_is_type/entity_type_by_id on target_entity_id but never on source_entity_id (or vice versa), while the apply path inserts into the join/refs table before it loads/reads the unchecked side. Ask: if the unchecked referent has been deleted, does this become a raw FK/internal error rather than a structured client error?
- **Detect:** A pre-apply validator checks target_entity_id but not source_entity_id (or vice versa) while the apply path inserts into a join/refs table before loading the unchecked side; ask whether a missing referent becomes an FK/internal error.

## Salvage a message's correlation id from the raw payload before strict schema decode can fail  ·  `salvage-correlation-id-before-strict-decode`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #154
- **Rule:** When a message/envelope that carries a correlation id (run/request/trace id) is parsed and then strictly schema-decoded, extract the correlation id from the raw parsed object BEFORE the full decode. If decode fails on some other field, the error path can still emit a diagnostic joinable to the original operation instead of an empty/placeholder id, preserving the trace correlation for the recoverable (non-syntax) failure class.
- **Detect:** Find a decode pipeline where the correlation id is read only off the fully-decoded struct, while an error/catch path logs with `id: ""`/default on decode failure. Ask: when the raw JSON parses but schema decode fails on an unrelated field, is the already-present id salvaged from the raw object, or lost — breaking the diagnostic join?

## Initialization of optional/diagnostic infrastructure must fail-open, not abort startup  ·  `optional-observability-subsystem-init-must-fail-open`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #151
- **Rule:** Setup of an optional, non-product subsystem (logging/tracing sink, metrics, telemetry, crash reporter) must not be a hard availability dependency at boot. Propagating its init error with `?`/throw turns a recoverable condition (e.g. an unwritable log dir) into a full startup failure, even though deleting the artifact changes no product behavior. Initialize it fail-open: on error, emit a single distinctive stderr marker and continue booting. Detection: a boot/startup sequence calls `<observability>::init()?` / `await initLogging()` whose failure propagates to the process entrypoint, while the subsystem is documented as derived/lossy/optional and its other sinks already degrade silently. Ask: should an unwritable log/metrics path crash the whole service?
- **Detect:** In a process/service startup sequence, an init call for an optional/diagnostic subsystem (logging/tracing sink, metrics, telemetry, crash reporter) propagates its error to the entrypoint — Rust `logging::init()?` / `tracing_subscriber...try_init()?`, or JS `await initLogging()` that can throw — so the whole boot aborts. Discriminator (the deletion test): if you deleted this subsystem's output artifact, would any PRODUCT behavior change? If no, its init is not an availability dependency. Flag when such an init can fail on an environmental condition (unwritable/absent log/metrics dir, missing sink path) and that failure isn't caught. Stronger signal: a sibling sink for the same subsystem already degrades silently (env-gated try/catch, best-effort) — the boot path should match it. Fix: catch the error, emit one distinctive stderr marker, and continue booting.

## Fail fast on a missing required field instead of a placeholder sentinel  ·  `fail-fast-on-missing-required-field-no-placeholder-sentinel`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #176
- **Rule:** When a render/serialization path needs a field that is contractually required (a provenance id, target id, owner) and the input type makes it optional, do not paper over absence with a placeholder sentinel (`unwrap_or("unknown")`, `?? "n/a"`, `|| 'missing'`) that gets baked into user- or model-facing output. The sentinel silently survives a wiring regression and produces an unusable/misleading transcript instead of surfacing the bug. Require the value (`.expect(...)` / throw / return Err) so a missing field fails loudly at the point it is consumed, and have callers/tests pass a real value.
- **Detect:** Grep for `unwrap_or("...")` / `?? "..."` / `|| "..."` where the default is a human placeholder string ("unknown", "n/a", "missing", "none") and the result flows into rendered output, a stored snapshot, or a message replayed to a model. Ask: is this field actually required for the output to be correct? If yes, prefer failing fast over emitting the sentinel; a default that masks missing wiring is the smell.

## Preserve underlying error cause/details in user-facing and log messages  ·  `preserve-error-cause-in-messages`
- **Severity:** nit  ·  **Support:** 4  ·  **Seen in:** #4133, #28207, #29635, #29784
- **Rule:** Flag a failure branch that emits a static generic message (e.g. `Failed to parse X`) while a richer caught error/cause object is available and not surfaced anywhere. Bind the error and include a sanitized summary of the underlying cause (field/type/position). Skip when the cause is already included or logged with full detail, or when surfacing it would leak sensitive data.
- **Detect:** Flag a catch/failure branch emitting a static message while a `cause`/`error` object is available but only logged or dropped; flag `catch {` or `catch (e) {` with unused `e` logging a static string (esp. around JSON.parse); flag swaps from a formatting validator to raw decode + generic 'Failed to parse X'. Ask: are actionable details surfaced?

## Do not log expected/handled errors at error/warn level  ·  `no-noisy-logging-for-expected-errors`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #28301, #28434
- **Rule:** When an error is expected and handled as normal control flow (file-not-found/ENOENT on first run, a JSON-RPC -32601 method-not-found that drives a known fallback), do not log it unconditionally at error/warn level in a shared helper. Branch on the expected error type and skip or downgrade its log (while still warning on genuinely unexpected parse/permission errors), or give callers a way to suppress/downgrade logging for the known case.
- **Detect:** Find log.error/log.warn inside a shared catch/catchCause/catchAll that fires unconditionally without branching on a NotFound/ENOENT/specific-code error type, where a caller also uses that same error to drive expected fallback/blocklist behavior. Ask: is there a normal path where this 'error' is expected yet still logged loudly with no suppression?

## Restore mutated globals in finally so a throw doesn't leak state  ·  `restore-mutated-globals-in-finally`
- **Severity:** nit  ·  **Support:** 2  ·  **Seen in:** #5162, #31709
- **Rule:** In tests (or any code) that mutates a global/env var and restores it after a throwing/awaited call, perform the restore in a `finally` block (or `afterEach`), so a thrown statement between mutation and restore doesn't leak the mutated value into later tests.
- **Detect:** In tests, find a global/env mutation followed by an `await`/throwing call and a later restore that is NOT in finally/afterEach. Ask: if the awaited call throws, is the global still restored?
