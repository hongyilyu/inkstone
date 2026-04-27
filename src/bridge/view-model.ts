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
	 * Ordered block list. User messages always have exactly one `text` part.
	 * Assistant messages may interleave `text` and `thinking` parts in the
	 * order the model emitted them (driven by pi-ai's `text_start` /
	 * `thinking_start` boundaries). Redacted thinking is dropped at
	 * `thinking_end` time, so no `redacted` flag lives on parts.
	 * Known placeholder strings (`[REDACTED]` from OpenRouter,
	 * `Reasoning hidden by provider` from pi-kiro conformance §26a)
	 * are stripped in the reducer — see `REDACTED_THINKING_PLACEHOLDERS`
	 * in `tui/context/agent.tsx`.
	 */
	parts: DisplayPart[];
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
	/**
	 * pi-ai's `AssistantMessage.errorMessage`, populated when the turn ended
	 * with `stopReason === "error" | "aborted"`. Rendered as a warning-
	 * bordered panel below the assistant body. Mirrors OpenCode's per-message
	 * error surface (`routes/session/index.tsx:1374-1387`), trimmed to a
	 * single field — Inkstone doesn't yet differentiate abort ("interrupted"
	 * footer suffix) from hard error (red panel); both render as the panel.
	 * That's a deferred polish, not a semantic contract difference.
	 *
	 * Optional for backward compatibility with sessions persisted before this
	 * field existed.
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

export interface SessionData {
	messages: DisplayMessage[];
	/**
	 * Agent active at the time the session was saved. Optional for backward
	 * compatibility with sessions persisted before multi-agent support. When
	 * present, restoring the session uses this value in preference to the
	 * last-selected agent from `config.json` — otherwise a persisted session
	 * could reopen under the wrong agent if config drifted independently.
	 */
	currentAgent?: string;
}
