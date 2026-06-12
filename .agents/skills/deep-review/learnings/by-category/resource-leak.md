# Learned rules — Resource leaks (`resource-leak`)

_5 rules. Loaded by the `dr-resource-leak` specialist. Generated from rules.json — do not edit by hand; run build_kb.py._

## Reset transient state flags in finally, not only on the success path  ·  `reset-flag-in-finally-around-await`
- **Severity:** important  ·  **Support:** 3  ·  **Seen in:** #117, #1723, #26949
- **Rule:** When a boolean/mode flag is set before an awaited operation, clear it in a try/finally (or on every return and error path) so a thrown rejection or early return cannot leave the flag stuck on.
- **Detect:** Flag code that sets a flag true (setState('x', true)) before an await/loop containing await, where the reset to false only appears on the success path and there is no try/finally and no clear on early-return/catch. Ask: does every exit path (error, early return) reset this flag?

## Subprocess teardown must reliably terminate the child on every path  ·  `ensure-subprocess-reliably-terminates`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #25962
- **Rule:** When managing a Node child_process/Worker, ensure termination on every path: (1) after posting a fatal startup error to the parent, the child should call process.exit()/self.close(); (2) stop()/shutdown() should return an awaitable Promise that resolves on the child's 'exit'/'stopped' event (force-killing only after a grace timeout) rather than firing a detached setTimeout(kill) that a parent's own exit may cancel. Flag only genuine child_process/Worker management, not generic async cleanup.
- **Detect:** Two checks per hunk: (1) in a child/worker catch block that does parentPort.postMessage({type:'error'}) or similar, is there a following process.exit/self.close? (2) Does stop()/shutdown() post a 'stop' message then return void/synchronously with a setTimeout(...kill), rather than returning a Promise awaited by relaunch/update/quit callers? Ask: can the subprocess survive a failed startup or a parent that exits before the kill timer fires?

## Clean up temp files in finally and don't auto-retry after stream events emitted  ·  `guard-or-finally-cleanup-temp-and-pre-stream-retry`
- **Severity:** important  ·  **Support:** 2  ·  **Seen in:** #1723, #4133
- **Rule:** Place temp-file cleanup (unlinkSync) in a finally block (ignoring unlink errors) so a throw from the read does not leak the file; cleanup on the success path only leaks when the read throws. Separately, before auto-retrying a failed assistant turn, check whether the provider already emitted stream events for that message and do not retry if so, to avoid duplicate/garbled output.
- **Detect:** try { const x = readFileSync(tmp); unlinkSync(tmp); } catch { return } with unlink inside try not finally; or retry-decision logic returning retryable=true on error code/stopReason without checking an events-already-emitted flag.

## Bound concurrency for per-item async I/O over unbounded collections  ·  `bound-concurrency-for-per-item-io`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #28532
- **Rule:** When using Promise.all/allSettled over items.map(async ...) where each callback performs filesystem or network I/O and the collection size is unbounded or attacker/data-controlled (directory listings, query results, user input), cap concurrency with a limiter/pool or batched processing. Do not flag fixed-size or small bounded collections, or maps that perform only in-memory/CPU work.
- **Detect:** Flag Promise.all(items.map(async ... await fs/io ...)) where items can be arbitrarily large (directory entries, query results, etc.) and each callback performs filesystem or network I/O. Ask: is the size of items bounded, and is concurrency capped?

## Set kill_on_drop or explicitly wait an owned tokio::process::Child  ·  `kill-on-drop-or-wait-owned-tokio-child`
- **Severity:** important  ·  **Support:** 1  ·  **Seen in:** #102
- **Rule:** tokio::process::Child does not kill the subprocess on drop by default. For an owned worker child stored in a struct, either set .kill_on_drop(true) at spawn or explicitly child.wait().await/kill on all exit paths (park, stdout EOF), so a worker that emits its last frame but keeps running cannot leak an orphaned process when its owner is dropped on an early return.
- **Detect:** Command::...spawn() whose Child is stored in a struct field; check for .kill_on_drop(true) on the builder or an explicit child.wait()/child.kill() on all exit paths. Flag if neither is present and the struct can be dropped while the process may still be alive.
