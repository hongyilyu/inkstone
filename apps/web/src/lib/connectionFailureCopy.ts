/**
 * Per-send copy for a failed message, chosen from the send's OWN error (ADR-0051).
 *
 * The error is authoritative for THIS send: we parse its `reason`, NOT the ambient
 * connection signal. Branching on the `SubscriptionRef` would race a concurrent
 * reconnect (the link could heal between the failed write and the read), and would
 * mis-attribute a non-connection failure that happened to coincide with a blip.
 */

/** The message shown when a send fails because the Core link is down (ADR-0051). */
export const CONNECTION_SEND_FAILURE =
	"Inkstone may have lost its connection — check it's running, then try again.";

/** The generic send-failure copy (any non-connection cause). */
export const GENERIC_SEND_FAILURE =
	"Couldn't send your message. Please try again.";

/**
 * Connection-specific copy when `error` is a connection-caused `WsRequestError`
 * (its `reason` is `"connection_lost"` — a mid-flight drop — or `"send_failed"` —
 * a write on a dead socket), else `null` (the caller falls back to
 * {@link GENERIC_SEND_FAILURE}).
 *
 * Read `_tag`/`reason` DEFENSIVELY: the value is `unknown` (the bridge's
 * `Cause.squash` output), so duck-type on the fields rather than `instanceof` — a
 * leaked `FiberFailure`, a plain `Error`, `undefined`, or a `WsRequestError` with
 * any other `reason` all fall through to `null`. The raw `reason` token is never
 * surfaced as copy (BookmarkEditor precedent).
 */
export function connectionFailureCopy(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const { _tag, reason } = error as { _tag?: unknown; reason?: unknown };
	if (_tag !== "WsRequestError") return null;
	return reason === "connection_lost" || reason === "send_failed"
		? CONNECTION_SEND_FAILURE
		: null;
}
