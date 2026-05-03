/**
 * Session-lifetime mutable state + the two small helpers that wrap it.
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
 * `persistThen` and `ensureSession` live here too because they close
 * over `currentSessionId`. Exposing the bag as getter/setter pairs keeps
 * the other modules free of top-level `let`s.
 */

import type { Session } from "@backend/agent";
import {
	createSession,
	runInTransaction,
	type Tx,
} from "@backend/persistence/sessions";
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
	 * Ensure we have a session row to write to. Called from inside the
	 * user-prompt path (before we push the user bubble) so only actually
	 * active sessions get rows. Also forwards the id to pi-agent-core
	 * and seeds `store.sessionTitle` to the newly-created row's title.
	 */
	ensureSession(): string;
	/**
	 * Persist-first helper: run a tx body and apply a follow-up store
	 * mutation only if the tx succeeded. Used at reducer sites that
	 * mutate already-persisted state — inverts the old mutate-then-
	 * persist ordering so a failed write leaves the store at its
	 * pre-mutation value. The user-visible signal on failure is the
	 * toast already fired by `reportPersistenceError` inside the
	 * writer (or `runInTransaction`'s outer catch for pre-writer
	 * tx-open failures); the dedup sentinel on the error object stops
	 * the rethrow from double-toasting up the chain.
	 *
	 * Pre-stream sites (new bubble / new shell / tool-result persist /
	 * synthesized-abort persist) have no store state to gate — they
	 * use `safeRun` instead, which preserves today's "log and continue"
	 * behavior.
	 */
	persistThen(writes: (tx: Tx) => void, onSuccess: () => void): void;
}

export function createSessionState(params: {
	agentSession: Session;
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
}): SessionState {
	let currentSessionId: string | null = null;
	let turnStartThinkingLevel: ThinkingLevel | undefined;
	let preTurnCodexConnections: number | undefined;

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

	function persistThen(writes: (tx: Tx) => void, onSuccess: () => void): void {
		try {
			runInTransaction(writes);
		} catch {
			// Already reported by the writer or by runInTransaction's
			// outer catch. Skip onSuccess so the store stays at its
			// pre-mutation value.
			return;
		}
		onSuccess();
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
		ensureSession,
		persistThen,
	};
}
