/**
 * Session-lifetime mutable state + `ensureSession` lazy-init helper.
 *
 * The reducer and `wrappedActions` both need to read/write:
 *   - `currentSessionId` — the SQLite row id for the active session,
 *     lazily created on first prompt.
 *   - `turnStartThinkingLevel` — reasoning effort captured at the
 *     turn's user-prompt commit, used at `agent_end` to stamp the
 *     turn-closing bubble with the value that produced it (not
 *     whatever the store holds at event time, which can drift during
 *     a mid-stream model/effort switch).
 *   - `preTurnCodexConnections` — pi-ai's WebSocket connection counter
 *     snapshot taken before the turn fires. Read in `agent_end` to
 *     infer `ws` vs `sse` transport. Populated only when Codex is the
 *     active provider.
 *
 * `ensureSession` lives here because it closes over `currentSessionId`.
 * Exposing the bag as getter/setter pairs keeps the other modules free
 * of top-level `let`s.
 *
 * The persist-first gate (formerly `persistThen` here) now lives inside
 * `MessageLog` — see `message-log.ts`. Every persist-first call site
 * that mutates `store.messages` is a `MessageLog` method, so the gate
 * sits next to the writers it gates instead of split across two
 * modules. The lone non-message persist-first site
 * (`startSessionTitleTask` in `actions/prompt.ts`) uses
 * `persist(writes, { onSuccess })` directly — three lines, single
 * caller, no abstraction earned.
 */

import type { Session } from "@backend/agent";
import { createSession } from "@backend/persistence/sessions";
import type { AgentStoreState } from "@bridge/view-model";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { SetStoreFunction } from "solid-js/store";

export interface SessionState {
	/** Get the active session id, or `null` pre-first-prompt. */
	getCurrentSessionId(): string | null;
	/** Overwrite the session id (e.g. `clearSession` sets `null`, `resumeSession` sets the loaded id). */
	setCurrentSessionId(id: string | null): void;
	getTurnStartThinkingLevel(): ThinkingLevel | undefined;
	setTurnStartThinkingLevel(level: ThinkingLevel | undefined): void;
	getPreTurnCodexConnections(): number | undefined;
	setPreTurnCodexConnections(n: number | undefined): void;
	/**
	 * Routing-seam handoff. Set by the reducer's `applyDispatchResult`
	 * after `forkSession()` succeeds. Read by `handleAgentEnd` — when
	 * the router's natural turn-close fires, pi-agent-core's loop is
	 * actually idle (`agent_end` is the loop's last event), at which
	 * point `clearSession`'s `agent.reset()` can run synchronously
	 * without racing against in-flight loop state. `handleAgentEnd`
	 * triggers the resume into the child session, then clears this
	 * field. Until cleared, the prompt stays locked (`isStreaming`
	 * is not reset) so a fast user can't submit on the about-to-be-
	 * abandoned router session.
	 */
	getPendingDispatchChildId(): string | null;
	setPendingDispatchChildId(id: string | null): void;
	/**
	 * Ensure we have a session row to write to. Called from inside the
	 * user-prompt path (before we push the user bubble) so only actually
	 * active sessions get rows. Also forwards the id to pi-agent-core
	 * and seeds `store.sessionTitle` to the newly-created row's title.
	 */
	ensureSession(): string;
}

export function createSessionState(params: {
	agentSession: Session;
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
}): SessionState {
	let currentSessionId: string | null = null;
	let turnStartThinkingLevel: ThinkingLevel | undefined;
	let preTurnCodexConnections: number | undefined;
	let pendingDispatchChildId: string | null = null;

	function ensureSession(): string {
		if (currentSessionId) return currentSessionId;
		const rec = createSession({
			agent: params.store.currentAgent,
		});
		currentSessionId = rec.id;
		// Forward the session id to pi-agent-core so providers that
		// key behavior on it (Codex's `websocket-cached` / `"auto"`
		// transport uses it as both the `prompt_cache_key` and the
		// WebSocket connection cache) can thread requests through a
		// single reusable context. Idempotent across turns; only the
		// first call per session is load-bearing. Other providers
		// ignore the field.
		params.agentSession.setSessionId(rec.id);
		params.setStore("sessionTitle", rec.title);
		return rec.id;
	}

	return {
		getCurrentSessionId: () => currentSessionId,
		setCurrentSessionId: (id) => {
			currentSessionId = id;
		},
		getTurnStartThinkingLevel: () => turnStartThinkingLevel,
		setTurnStartThinkingLevel: (level) => {
			turnStartThinkingLevel = level;
		},
		getPreTurnCodexConnections: () => preTurnCodexConnections,
		setPreTurnCodexConnections: (n) => {
			preTurnCodexConnections = n;
		},
		getPendingDispatchChildId: () => pendingDispatchChildId,
		setPendingDispatchChildId: (id) => {
			pendingDispatchChildId = id;
		},
		ensureSession,
	};
}
