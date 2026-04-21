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
  id: string
  role: "user" | "assistant"
  text: string
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
  agentName?: string
  modelName?: string
  duration?: number // ms
}

export interface AgentStoreState {
  messages: DisplayMessage[]
  isStreaming: boolean
  activeArticle: string | null
  modelName: string
  modelProvider: string
  contextWindow: number
  status: "idle" | "streaming" | "tool_executing"
  totalTokens: number
  totalCost: number
  lastTurnStartedAt: number
}

export interface SessionData {
  messages: DisplayMessage[]
  activeArticle: string | null
}
