/**
 * Shared view-model contract between the backend agent and any frontend.
 *
 * This module is pure TypeScript with zero runtime. It defines the data
 * shapes that cross layer boundaries:
 *
 *   - `DisplayMessage` — how a single user/assistant message is rendered.
 *   - `AgentStoreState` — the shape of the per-session state a frontend holds.
 *   - `SessionData` — what gets persisted to disk so a new session can
 *     resume the previous conversation.
 *
 * A future non-TUI frontend would import these types, render `DisplayMessage`
 * its own way, and call `saveSession()` / `loadSession()` with the same
 * `SessionData` shape. The backend's `AgentActions` surface is *not* defined
 * here — that lives in `backend/agent/` because it describes the backend's
 * public API, not a shared view-state contract.
 */

export interface DisplayMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	// `agentName` and `modelName` are per-message: each assistant bubble records
	// the agent and model that produced *that specific* reply, sourced from the
	// `message_end` event (not from mutable store state).
	//
	// `duration` is per-turn: the wall-clock time from the user's prompt to the
	// turn completing. It is stamped only on the turn-closing assistant bubble
	// (the final assistant message whose `stopReason !== "toolUse"`), so
	// intermediate assistant messages in a tool-driven turn intentionally carry
	// `agentName` + `modelName` without a `duration`.
	//
	// All three are optional because user messages don't have them and legacy
	// persisted sessions predate these fields.
	agentName?: string;
	modelName?: string;
	duration?: number; // ms
}

export interface AgentStoreState {
	messages: DisplayMessage[];
	isStreaming: boolean;
	activeArticle: string | null;
	modelName: string;
	/**
	 * Provider id (e.g. "amazon-bedrock"), not a display string. Frontends
	 * resolve this through `backend/providers` when rendering so formatting
	 * stays a pure UI concern.
	 */
	modelProvider: string;
	contextWindow: number;
	status: "idle" | "streaming" | "tool_executing";
	totalTokens: number;
	totalCost: number;
	lastTurnStartedAt: number;
	/**
	 * Name of the currently-active agent persona (e.g. "reader", "example").
	 * The full agent registry is static, owned by `backend/agent/agents.ts`,
	 * and imported directly by any frontend that needs the agent list — so
	 * only the selected agent crosses the bridge as reactive state.
	 */
	currentAgent: string;
}

export interface SessionData {
	messages: DisplayMessage[];
	activeArticle: string | null;
	/**
	 * Agent active at the time the session was saved. Optional for backward
	 * compatibility with sessions persisted before multi-agent support. When
	 * present, restoring the session uses this value in preference to the
	 * last-selected agent from `config.json` — otherwise a persisted session
	 * could reopen under the wrong agent if config drifted independently.
	 */
	currentAgent?: string;
}
