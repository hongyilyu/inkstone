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

/** Copy when Core rejects a send because the selected model's provider has no
 * credential (`-32004`, ADR-0062) — the model can't be used until it's connected. */
export const PROVIDER_NOT_CONNECTED_SEND_FAILURE =
	"That model's provider isn't connected. Connect it in Settings, then try again.";

/** The JSON-RPC code Core frames for a disconnected-provider send (ADR-0062),
 * mirroring `HandlerError::ProviderNotConnected`. The SDK preserves it on
 * `WsRequestError.code`, so the Web branches on the code, never the message text. */
const PROVIDER_NOT_CONNECTED_CODE = -32004;

/**
 * Specific copy for a failed send, chosen from the send's OWN error (ADR-0051),
 * else `null` (the caller falls back to {@link GENERIC_SEND_FAILURE}). Two causes
 * get their own line:
 *   - a connection-caused `WsRequestError` (`reason` `"connection_lost"` — a
 *     mid-flight drop — or `"send_failed"` — a write on a dead socket);
 *   - a provider-not-connected rejection (Core `-32004`, carried on `code`).
 *
 * Read the fields DEFENSIVELY: the value is `unknown` (the bridge's `Cause.squash`
 * output), so duck-type rather than `instanceof` — a leaked `FiberFailure`, a plain
 * `Error`, `undefined`, or a `WsRequestError` with any other `reason`/`code` all
 * fall through to `null`. The raw `reason`/message token is never surfaced as copy.
 */
export function connectionFailureCopy(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const { _tag, reason, code } = error as {
		_tag?: unknown;
		reason?: unknown;
		code?: unknown;
	};
	if (_tag !== "WsRequestError") return null;
	if (code === PROVIDER_NOT_CONNECTED_CODE) {
		return PROVIDER_NOT_CONNECTED_SEND_FAILURE;
	}
	return reason === "connection_lost" || reason === "send_failed"
		? CONNECTION_SEND_FAILURE
		: null;
}
