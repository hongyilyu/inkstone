import { expect, test } from "./fixtures.js";

/**
 * Connection-specific send copy on a dropped link (ADR-0051): real Core + built
 * Web Client. When a send's in-flight request is dropped, ChatColumn surfaces the
 * connection-specific copy ("Inkstone may have lost its connection…"), not the
 * generic "Couldn't send…" fallback.
 *
 * (The always-visible "Lost connection" indicator that ADR-0051 originally
 * rendered was removed in the feature-cut sweep — see the ADR-0051 removal
 * amendment — so this spec no longer asserts the pill; only the per-send copy,
 * which is independent of the ambient signal and was deliberately kept. The
 * unbounded reconnect transport itself is proven in ui-sdk vitest.)
 *
 * The drop is forced with `page.routeWebSocket` rather than a SIGTERM race: the
 * route proxies `/ws` to real Core verbatim, then CLOSES the link the instant the
 * client sends a `thread/create` frame — so the in-flight request fails
 * `connection_lost` regardless of how fast Core would have replied (the old
 * send-then-SIGTERM approach raced Core's reply and flaked on CI).
 */
test("dropped socket: an in-flight send shows the connection-specific copy", async ({
	chat,
}) => {
	const { page } = chat;

	// Drop the client's socket DETERMINISTICALLY the instant the `thread/create` request
	// is sent — independent of Core's reply speed. The old approach (send, then SIGTERM
	// Core) raced the kill against Core answering the create: on CI the tiny DB-write
	// reply often won (send succeeds → navigates, no alert) or the frame hadn't flushed
	// yet (no in-flight request) — connection-status.spec.ts flaked on CI (and reds master)
	// while passing locally. `routeWebSocket` proxies `/ws` to real Core and forwards both
	// directions verbatim, UNTIL the client sends a `thread/create` frame; then it CLOSES
	// the proxy (the in-flight request never gets a reply → `connection_lost` → the
	// connection-specific copy) and never reconnects (Core is unreachable through the dead
	// proxy), so the indicator settles to "Lost connection" too. No wall-clock dependence,
	// so no SIGTERM is needed for the drop. Registered BEFORE goto so the socket-open is
	// intercepted.
	let linkDropped = false;
	await page.routeWebSocket(/\/ws$/, (ws) => {
		// Once dropped, REFUSE every reconnect: closing without connecting to Core keeps
		// the in-flight `thread/create` request failed (connection_lost) instead of a
		// reconnect re-proxying to live Core and letting a retry succeed.
		if (linkDropped) {
			ws.close();
			return;
		}
		const server = ws.connectToServer();
		ws.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			if (text.includes('"method":"thread/create"')) {
				// The request is now in flight; drop the link so it fails connection_lost
				// and latch the drop so reconnects keep failing.
				linkDropped = true;
				ws.close();
				server.close();
				return;
			}
			server.send(message);
		});
		server.onMessage((message) => ws.send(message));
	});

	await chat.goto();

	// `chat.goto()` landed on the welcome (no focused thread), so this send mints a thread
	// → `sendNewThread` → a `thread/create` request. The route above drops the socket the
	// moment that frame is sent, failing the in-flight request with `connection_lost`,
	// which ChatColumn maps to the connection-specific copy.
	await chat.send("are you there?");

	// The send-error alert shows the CONNECTION-SPECIFIC copy. The /lost its
	// connection/i pattern matches CONNECTION_SEND_FAILURE ("Inkstone may have lost
	// its connection…") and would NOT match the generic "Couldn't send your
	// message." fallback.
	await expect(page.getByRole("alert")).toHaveText(/lost its connection/i, {
		timeout: 15_000,
	});
});
