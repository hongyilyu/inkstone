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
 * `file` is display-only: an agent command (e.g. reader's `/article`) can
 * hand the TUI a compact render shape — a short prose line plus a file
 * chip — while still passing the *full* file content as the prompt text
 * that reaches pi-agent-core. The LLM sees the single full text; the
 * bubble renders the compact parts. `mime` drives the badge label
 * (`text/markdown` → `"md"`, fall back to the raw mime), `filename` is
 * the display path (typically vault-relative).
 *
 * `tool` is an assistant-only part produced when the LLM invokes a tool.
 * pi-ai puts the `ToolCall` in the assistant message's `content`, so the
 * part lives on the assistant bubble that emitted it (not a standalone
 * row between bubbles). `callId` is pi-ai's `ToolCall.id` and is the
 * join key between the stream's `toolcall_end` event (which carries the
 * arguments) and the later `tool_execution_end` event (which carries
 * the result). `state` transitions `pending → completed | error`:
 * pushed as `"pending"` on `toolcall_end`, flipped by
 * `tool_execution_end`. `error` holds a short human-readable message
 * for failed tools; success results aren't stashed on the part because
 * today's tools carry all the user-visible information in their args
 * (the raw `AgentToolResult` stays in `agent_messages` as the
 * LLM-facing source of truth).
 */
export type DisplayPart =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "file"; mime: string; filename: string }
	| {
			type: "tool";
			callId: string;
			name: string;
			args: unknown;
			state: "pending" | "completed" | "error";
			error?: string;
	  };

/**
 * A dynamic sidebar section set by an agent tool (`update_sidebar`).
 * Ephemeral — lives only in the Solid store, not persisted to SQLite.
 * Sections are keyed by `id` for upsert/delete semantics.
 */
export interface SidebarSection {
	id: string;
	title: string;
	/** Markdown content rendered via `<markdown>` in the sidebar. */
	content: string;
}

export interface DisplayMessage {
	id: string;
	role: "user" | "assistant";
	/**
	 * Ordered block list. User messages are usually a single `text` part,
	 * but commands that hand the TUI explicit `displayParts` (e.g. reader's
	 * `/article`) can place any mix of `text` + `file` parts here — the
	 * LLM-facing prompt text is separate and always passed unmodified to
	 * pi-agent-core. Assistant messages may interleave `text`, `thinking`,
	 * and `tool` parts in emission order. Redacted-thinking handling
	 * lives in the reducer — see `REDACTED_THINKING_PLACEHOLDERS` in
	 * `tui/context/agent.tsx`.
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
	 * pi-ai's `AssistantMessage.errorMessage`, populated only when the
	 * turn ended with `stopReason === "error"`. Rendered as a warning-
	 * bordered panel below the assistant body. NOT set for aborts —
	 * those are signalled via `interrupted` instead so the UI can
	 * differentiate user-initiated cancellation from a hard provider
	 * error. The split is enforced by the reducer at live `message_end`
	 * time (`tui/context/agent.tsx`) and persisted in the `messages`
	 * table's `error` column, round-tripped on resume.
	 */
	error?: string;
	/**
	 * Set when the turn ended with `stopReason === "aborted"` — user
	 * pressed ESC twice, Ctrl+C, etc. The bubble footer suffix flips
	 * to ` · interrupted` and the agent glyph tints to `textMuted`;
	 * the red error panel is suppressed (the user knows the turn
	 * didn't complete, no need for a scary-looking error panel).
	 * Mirrors OpenCode's `MessageAbortedError` split in
	 * `routes/session/index.tsx`. Persisted in the `messages` table's
	 * `interrupted` column so resumed sessions replay the correct
	 * render.
	 */
	interrupted?: boolean;
}

export interface AgentStoreState {
	messages: DisplayMessage[];
	isStreaming: boolean;
	/**
	 * Dynamic sidebar sections set by the `update_sidebar` tool.
	 * Ephemeral — cleared on `clearSession()`, not persisted.
	 */
	sidebarSections: SidebarSection[];
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
