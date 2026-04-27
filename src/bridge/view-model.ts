/**
 * Shared view-model contract between the backend agent and any frontend.
 *
 * This module is pure TypeScript with zero runtime. It defines the data
 * shapes that cross layer boundaries:
 *
 *   - `DisplayMessage` — how a single user/assistant message is rendered.
 *   - `AgentStoreState` — the shape of the per-session state a frontend holds.
 *
 * The backend's `AgentActions` surface is *not* defined here — that lives
 * in `backend/agent/` because it describes the backend's public API, not a
 * shared view-state contract.
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

/**
 * A single rendered block inside an assistant (or user) message. Mirrors
 * pi-ai's per-block event model so interleaved thinking/text from a single
 * assistant turn renders in source order instead of being collapsed into
 * one flat string.
 *
 * Kept intentionally narrow — `tool` is not a part type because Inkstone
 * doesn't render tool calls in bubbles yet; when it does, this union grows.
 */
export type DisplayPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string };

export interface DisplayMessage {
	id: string;
	role: "user" | "assistant";
	/**
	 * Ordered block list. User messages have exactly one `text` part;
	 * assistant messages may interleave `text` and `thinking` parts in
	 * emission order. Redacted-thinking handling lives in the reducer —
	 * see `REDACTED_THINKING_PLACEHOLDERS` in `tui/context/agent.tsx`.
	 */
	parts: DisplayPart[];
	// `agentName` / `modelName` are per-message (stamped in `message_end`);
	// `duration` is per-turn (stamped in `agent_end` on the turn-closing
	// bubble only). See `docs/ARCHITECTURE.md` § Duration and transient state.
	// Optional because user messages don't have them.
	agentName?: string;
	modelName?: string;
	duration?: number; // ms
	/**
	 * pi-ai's `AssistantMessage.errorMessage`, populated when the turn
	 * ended with `stopReason === "error" | "aborted"`. Rendered as a
	 * warning-bordered panel below the assistant body.
	 */
	error?: string;
}

export interface AgentStoreState {
	messages: DisplayMessage[];
	isStreaming: boolean;
	modelName: string;
	/**
	 * Provider id (e.g. "amazon-bedrock"), not a display string. Frontends
	 * resolve this through `backend/providers` when rendering so formatting
	 * stays a pure UI concern.
	 */
	modelProvider: string;
	contextWindow: number;
	/**
	 * Whether the currently-selected model supports reasoning (pi-ai's
	 * `Model.reasoning` capability flag). Surfaced into the store so reactive
	 * UI (e.g. the palette visibility of the "Effort" entry, the statusline
	 * effort badge) can gate on it without a backend call.
	 */
	modelReasoning: boolean;
	/**
	 * Reasoning effort currently applied to the active model. Mirrors
	 * pi-agent-core's `Agent.state.thinkingLevel`. `"off"` when the model is
	 * non-reasoning or when the user explicitly selected "Off". Storage is
	 * per-model (keyed by `${providerId}/${modelId}` in `config.json`) — this
	 * field is the resolved value for the *currently-selected* model, not the
	 * full per-model map.
	 */
	thinkingLevel: ThinkingLevel;
	status: "idle" | "streaming" | "tool_executing";
	totalTokens: number;
	totalCost: number;
	lastTurnStartedAt: number;
	/**
	 * Name of the currently-active agent persona (e.g. "reader").
	 * The full agent registry is static, owned by `backend/agent/agents.ts`,
	 * and imported directly by any frontend that needs the agent list — so
	 * only the selected agent crosses the bridge as reactive state.
	 */
	currentAgent: string;
}
