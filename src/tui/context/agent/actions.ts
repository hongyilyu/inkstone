/**
 * User-verb actions: thin router. Each verb dispatches to a focused
 * module under `./actions/`. The dispatch shape lives here so the
 * `AgentContextValue["actions"]` contract stays in one file.
 *
 * Takes an `ActionDeps` bag over the session state, the backend
 * session, the store, and the toast/title-task surfaces. No top-level
 * module state; every piece of mutable lifetime data lives in
 * `SessionState`.
 */

import type {
	generateSessionTitle,
	Session,
	SuggestCommandDecision,
} from "@backend/agent";
import type { AgentStoreState, DisplayPart } from "@bridge/view-model";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { SetStoreFunction } from "solid-js/store";
import type { LayoutContextValue } from "../../context/layout";
import type { useToast } from "../../ui/toast";
import { clearSessionAction } from "./actions/clear";
import { promptAction } from "./actions/prompt";
import { resumeSessionAction } from "./actions/resume";
import type { PreviewRegistry } from "./preview-registry";
import type { SessionState } from "./session-state";
import type {
	AgentContextValue,
	PendingApproval,
	PendingSuggestion,
} from "./types";

export interface ActionDeps {
	agentSession: Session;
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
	sessionState: SessionState;
	layout: LayoutContextValue;
	toast: ReturnType<typeof useToast>;
	titleGenerator: typeof generateSessionTitle;
	/**
	 * Diff-preview registry. Session-boundary resets (clear / resume
	 * / unmount) wipe the archive so stale entries don't bleed into
	 * a different session's tool parts.
	 */
	previews: PreviewRegistry;
	/**
	 * Pending-approval accessor + resolver for `confirmDirs` flows.
	 * `abort` and `clearSession` wrappers call `respondApproval(false)`
	 * before propagating to the backend — see
	 * `docs/APPROVAL-UI.md` § Abort / clear ordering.
	 */
	pendingApproval: () => PendingApproval | null;
	respondApproval: (ok: boolean) => void;
	/**
	 * Pending-suggestion accessor + resolver for `suggest_command`.
	 * `abort` / `clearSession` must resolve to `"cancelled"` before
	 * the backend call — the tool's promise isn't wake-able by
	 * AbortController. See `docs/AGENT-DESIGN.md` D15.
	 */
	pendingSuggestion: () => PendingSuggestion | null;
	respondSuggestion: (decision: SuggestCommandDecision) => void;
}

export function createWrappedActions(
	deps: ActionDeps,
): AgentContextValue["actions"] {
	return {
		...deps.agentSession.actions,
		async prompt(text: string, displayParts?: DisplayPart[]) {
			await promptAction(text, displayParts, deps);
		},
		abort() {
			// Resolve pending TUI promises BEFORE backend abort — the
			// loop may be parked on `await confirmFn(...)` or
			// `await suggestCommandFn(...)` which AbortController
			// can't wake. See `docs/AGENT-DESIGN.md` D15 + approval
			// path.
			if (deps.pendingApproval()) deps.respondApproval(false);
			if (deps.pendingSuggestion()) deps.respondSuggestion("cancelled");
			deps.agentSession.actions.abort();
		},
		setModel(model: Model<Api>) {
			deps.agentSession.actions.setModel(model);
			deps.setStore("modelName", model.name);
			deps.setStore("modelProvider", model.provider);
			deps.setStore("contextWindow", model.contextWindow);
			deps.setStore("modelReasoning", model.reasoning);
			// Backend `setModel` also re-applies the per-model stored
			// thinkingLevel (or "off") onto the agent state, so surface that
			// into the store at the same time — otherwise the status-line
			// suffix would lag a model switch by one interaction.
			deps.setStore("thinkingLevel", deps.agentSession.getThinkingLevel());
		},
		setThinkingLevel(level: ThinkingLevel) {
			deps.agentSession.actions.setThinkingLevel(level);
			deps.setStore("thinkingLevel", level);
		},
		clearAgentModel() {
			// Backend re-resolves the effective model (top-level →
			// provider default) and applies it to the live agent
			// state. Mirror the resolved values into the store so the
			// sidebar / status line update without waiting for the
			// next turn — same shape as `setModel` above.
			deps.agentSession.actions.clearAgentModel();
			const m = deps.agentSession.getModel();
			deps.setStore("modelName", m.name);
			deps.setStore("modelProvider", m.provider);
			deps.setStore("contextWindow", m.contextWindow);
			deps.setStore("modelReasoning", m.reasoning);
			deps.setStore("thinkingLevel", deps.agentSession.getThinkingLevel());
		},
		clearAgentThinkingLevel() {
			deps.agentSession.actions.clearAgentThinkingLevel();
			deps.setStore("thinkingLevel", deps.agentSession.getThinkingLevel());
		},
		selectAgent(name: string) {
			// Agent-for-life invariant: swapping with messages in flight
			// would silently break prompt-cache stability (systemPrompt +
			// tools change mid-conversation) and scramble bubble agent
			// stamps. The backend throws on non-empty; we check here too
			// so the error surfaces before any UI state mutation.
			// See D13 in `docs/AGENT-DESIGN.md`.
			if (deps.store.messages.length > 0) {
				throw new Error(
					"Agent is fixed for the lifetime of a session. " +
						"Use /clear before selecting a different agent.",
				);
			}
			deps.agentSession.selectAgent(name);
			deps.setStore("currentAgent", deps.agentSession.agentName);
			// Backend `selectAgent` also flips the bound model + thinking
			// level to the destination agent's resolved values (per-agent
			// override → top-level → provider default). Surface those
			// into the store so sidebar / status-line / `/effort` reflect
			// the active agent's pick without waiting for the next turn.
			const m = deps.agentSession.getModel();
			deps.setStore("modelName", m.name);
			deps.setStore("modelProvider", m.provider);
			deps.setStore("contextWindow", m.contextWindow);
			deps.setStore("modelReasoning", m.reasoning);
			deps.setStore("thinkingLevel", deps.agentSession.getThinkingLevel());
		},
		async clearSession() {
			await clearSessionAction(deps);
		},
		resumeSession(sessionId: string) {
			resumeSessionAction(sessionId, deps);
		},
	};
}
