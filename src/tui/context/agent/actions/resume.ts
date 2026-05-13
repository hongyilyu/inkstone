/**
 * `resumeSession` — load a persisted session into the live Agent and
 * seed the Solid store. Lives in its own module so the dense ordering
 * invariants (clear → selectAgent → restoreMessages → store seeding)
 * have a focused home.
 *
 * Cross-agent resume is intentional (see D13 in
 * `docs/AGENT-DESIGN.md`): the "one agent per session" invariant
 * covers a session's in-memory lifetime. Resume constructs a fresh
 * in-memory lifetime, so we rebind the live Session onto the stored
 * session's agent rather than refusing.
 */

import { loadSession } from "@backend/persistence/sessions";
import { batch } from "solid-js";
import type { ActionDeps } from "../actions";

export function resumeSessionAction(sessionId: string, deps: ActionDeps): void {
	// Block during an in-flight turn. `isStreaming` is set on
	// `agent_start` and cleared on `agent_end` (which fires after
	// tool execution completes), so this one check covers both
	// streaming text and tool_executing status.
	if (deps.store.isStreaming) {
		deps.toast.show({
			variant: "warning",
			title: "Session busy",
			message: "Press Esc to stop the current turn, then try again.",
			duration: 4000,
		});
		return;
	}
	const loaded = loadSession(sessionId);
	if (!loaded) {
		deps.toast.show({
			variant: "error",
			title: "Session not found",
			message: `No session with id ${sessionId.slice(-8)}.`,
			duration: 4000,
		});
		return;
	}
	batch(() => {
		// Ordering matters. `agentSession.selectAgent` throws when
		// the live Agent's `messages.length > 0`; `clearSession`
		// wipes them first so the swap is always valid. Only then
		// do we seed the persisted history via `restoreMessages`.
		//
		// `agentSession.clearSession()` is async (see its doc), but
		// we've already guarded on `!store.isStreaming` above so
		// pi-agent-core has no `activeRun`; `waitForIdle()` short-
		// circuits and `reset()` is synchronous internally. The
		// returned Promise resolves with no side effects — fire-
		// and-forget is safe here because `batch()` can't contain
		// awaits and the idle path can't fail.
		void deps.agentSession.clearSession();
		if (loaded.session.agent !== deps.agentSession.agentName) {
			deps.agentSession.selectAgent(loaded.session.agent);
		}
		deps.agentSession.restoreMessages(loaded.agentMessages);
		deps.sessionState.setCurrentSessionId(loaded.session.id);
		// Forward the resumed session id so pi-ai's Codex cache keys
		// line up with this session's transcript on the first post-
		// resume turn. See `ensureSession` for the full rationale.
		deps.agentSession.setSessionId(loaded.session.id);
		// `currentAgent` is fanned in via the snapshot subscription —
		// `selectAgent` (when stored agent differs) triggers `notify()`,
		// and the cross-agent case is the only one where the value
		// actually changes. The same-agent resume path leaves the
		// snapshot unchanged, which is correct.
		deps.setStore("messages", loaded.displayMessages);
		deps.setStore("sessionTitle", loaded.session.title);
		// Token / cost counters are seeded from the sum of per-turn
		// `AssistantMessage.usage` persisted on each assistant row in
		// `agent_messages`. Synthesized alternation-repair placeholders
		// have no `usage` and contribute 0; aborted turns with partial
		// usage do contribute (those tokens were really paid for).
		deps.setStore("totalTokens", loaded.totals.tokens);
		deps.setStore("totalCost", loaded.totals.cost);
		deps.setStore("lastTurnStartedAt", 0);
		// Ephemeral UI state — reset so the resumed session doesn't
		// inherit stale sidebar sections or a Codex transport label
		// from a previous process. The secondary-page view follows
		// `currentSessionId` reactively (see
		// `secondary-page-history.ts` + the `setActiveSession` bridge
		// in `use-layout-keybinds.ts`), so this batch's
		// `setCurrentSessionId(loaded.session.id)` above swaps the
		// rendered page to the resumed session's `current` automatically
		// — no explicit close needed, and crucially history for both
		// the outgoing and incoming session is preserved (browser-tab
		// semantics, see ADR 0017).
		deps.setStore("sidebarSections", []);
		deps.setStore("codexTransport", undefined);
		deps.sessionState.setPreTurnCodexConnections(undefined);
		// Wipe diff-preview archive — entries are keyed by callId and
		// must not bleed across resume boundaries.
		deps.previews.clearAll();
	});
	deps.layout.scrollToBottom();
}
