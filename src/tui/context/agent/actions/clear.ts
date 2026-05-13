/**
 * `/clear` — wipe the in-memory session and let the next prompt create
 * a fresh SQLite row. Past rows stay on disk for `/resume`.
 *
 * Lives in its own module so the resolver-then-clear ordering
 * (deadlock-shape mirror of `abort`, see `docs/AGENT-DESIGN.md` D15)
 * is co-located with the code it constrains.
 */

import { closeSecondaryPage } from "../../secondary-page";
import type { ActionDeps } from "../actions";

export async function clearSessionAction(deps: ActionDeps): Promise<void> {
	// Resolve pending TUI promises before backend clear — same
	// deadlock shape as abort (see `docs/AGENT-DESIGN.md` D15).
	if (deps.pendingApproval()) deps.respondApproval(false);
	if (deps.pendingSuggestion()) deps.respondSuggestion("cancelled");
	// Await the backend clear first. Mid-stream path: it calls
	// `agent.abort()` + `waitForIdle()` so pi-agent-core's final
	// `message_end` + `agent_end` events fire through the reducer
	// BEFORE we wipe the store here. That means the reducer's
	// `isStreaming = false` and the pending-tool-part sweep both
	// run against the still-populated store, then we clear it.
	// Swapping the order (store-wipe then await) would mean the
	// reducer's `setStore("messages", lastIdx, ...)` writes would
	// race against an empty `messages` array.
	await deps.agentSession.clearSession();
	// In-memory reset only. We no longer terminate the DB row —
	// `ended_at` is gone, and the future `/resume` command will list
	// past rows as-is. `currentSessionId = null` here just means the
	// NEXT prompt creates a fresh row.
	deps.sessionState.setCurrentSessionId(null);
	deps.setStore("messages", []);
	deps.setStore("sidebarSections", []);
	deps.setStore("sessionTitle", "inkstone");
	closeSecondaryPage();
	deps.setStore("totalTokens", 0);
	deps.setStore("totalCost", 0);
	deps.setStore("lastTurnStartedAt", 0);
	// Reset the Codex transport indicator. A fresh session gets a
	// fresh WebSocket cache key; no claim should carry over from
	// the previous session's network state.
	deps.setStore("codexTransport", undefined);
	deps.sessionState.setPreTurnCodexConnections(undefined);
	deps.previews.clearAll();
}
