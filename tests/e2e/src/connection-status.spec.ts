import { expect, test } from "./fixtures.js";

/**
 * Socket-liveness indicator + connection-specific send copy on a dropped link
 * (ADR-0051): real Core + built Web Client. This is the user-visible DEGRADED
 * state — the always-on NavShell indicator morphing to "Lost connection" once
 * the client's own socket drops and its unbounded reconnect can't re-open, plus
 * a send whose in-flight request is dropped surfacing the connection-specific
 * copy (not the generic "Couldn't send…" fallback).
 *
 * The drop is forced with `page.routeWebSocket` rather than a SIGTERM race: the
 * route proxies `/ws` to real Core verbatim, then CLOSES the link the instant the
 * client sends a `thread/create` frame — so the in-flight request fails
 * `connection_lost` regardless of how fast Core would have replied (the old
 * send-then-SIGTERM approach raced Core's reply and flaked on CI). The proxy
 * never reconnects, so the indicator also settles to "Lost connection".
 *
 * Auto-recovery (reconnect → connected) is deliberately NOT covered here; it is
 * proven in ui-sdk vitest (slice 1).
 *
 * Selector choice: target the indicator by its visible "Lost connection" label
 * text (`getByText("Lost connection", { exact: true })`) — the page-object idiom
 * (no impl-only testid), which doubles as the assertion that the disconnected
 * treatment rendered. EXACT text isolates the visible glyph from the sr-only
 * role="status" span, whose copy also begins "Lost connection…".
 */
test("dropped socket: indicator shows Lost connection and an in-flight send shows the connection copy", async ({
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
		// the client retrying forever, so the indicator settles to "Lost connection"
		// instead of healing. (Without this, the client's reconnect would re-proxy to
		// live Core and flip back to "connected", never reaching the disconnected state.)
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

	// Connected resting state: the quiet dot carries no word, so the connected
	// signal is the ABSENCE of any degraded text (don't over-assert the dot).
	await expect(page.getByText(/lost connection/i)).toHaveCount(0);
	await expect(page.getByText(/reconnecting/i)).toHaveCount(0);

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

	// The always-on indicator reaches the "Lost connection" treatment. (We don't
	// race the brief "Reconnecting…" ramp — asserting it is flaky — only the
	// durable terminal state.) Target the VISIBLE label by EXACT text: the
	// indicator also renders an sr-only role="status" span whose text starts with
	// "Lost connection…", so a loose /lost connection/i matches both (strict-mode
	// violation); the exact match isolates the visible glyph's word.
	await expect(page.getByText("Lost connection", { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	// The role="status" region stably announces the retrying text once disconnected.
	await expect(
		page.getByRole("status").filter({ hasText: /lost connection.*retrying/i }),
	).toHaveText(/lost connection to inkstone\. retrying/i, { timeout: 15_000 });
});
