/**
 * Solid context contract for `AgentProvider`. The context value's
 * shape (`AgentContextValue`) is what every TUI consumer sees through
 * `useAgent()`. The pending-state DTOs (`PendingApproval`,
 * `PendingSuggestion`) are shared with `actions.ts`'s deps bag.
 *
 * `SessionFactory` lives next to its sole constructor in
 * `provider.tsx` — it's not part of the consumer-facing context shape.
 */

import type {
	AgentActions,
	PromptOptions,
	SuggestCommandDecision,
} from "@backend/agent";
import type { AgentStoreState } from "@bridge/view-model";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Accessor } from "solid-js";
import { createContext } from "solid-js";
import type { PreviewRegistry } from "./preview-registry";

export interface AgentContextValue {
	store: AgentStoreState;
	actions: Omit<AgentActions, "prompt"> & {
		/**
		 * Send a user turn. `text` is the full payload pi-agent-core hands
		 * to pi-ai (and in turn to the LLM). `opts` shapes the bubble
		 * (`displayParts`) and the session title (`title`); see
		 * `PromptOptions` in `@backend/agent` for full semantics.
		 */
		prompt(text: string, opts?: PromptOptions): Promise<void>;
		selectAgent(name: string): void;
		clearSession(): Promise<void>;
		resumeSession(sessionId: string): void;
	};
	/**
	 * Read accessors for dialog seeding. Exposed so dialog call sites
	 * (DialogModel, DialogVariant) don't need to reach into the backend
	 * module or duplicate the provider/model resolution.
	 */
	session: {
		getModel(): Model<Api>;
		getProviderId(): string;
		getModelId(): string;
		getThinkingLevel(): ThinkingLevel;
		/**
		 * The DB row id for the currently-active session, or null when
		 * no session has been committed yet (pre-first-prompt). Used by
		 * the session list panel to render the `●` current-session
		 * marker.
		 */
		getCurrentSessionId(): string | null;
	};
	/**
	 * Ephemeral per-`callId` diff preview registry. Populated when a
	 * `confirmDirs` rule awaits the user's approval and carries a
	 * `preview` in its `ConfirmRequest`; consumed by `ToolPart` to
	 * render the unified diff inline below the args line. Not
	 * persisted — see `preview-registry.ts` for rationale.
	 */
	previews: PreviewRegistry;
	/**
	 * Pending-approval signal for `confirmDirs` flows. When non-null,
	 * an approval is awaiting user response; the layout replaces the
	 * `Prompt` cell with `PermissionPrompt` and the panel's
	 * panel-local keyboard owns the Approve/Reject keys. Resolves to
	 * `true` / `false` via `respondApproval`. On provider unmount and
	 * session abort the provider resolves any in-flight entry to
	 * `false` so the agent loop unwinds cleanly.
	 */
	pendingApproval: Accessor<PendingApproval | null>;
	respondApproval: (ok: boolean) => void;
	/**
	 * Pending-suggestion signal for `suggest_command` tool calls.
	 * Layout swaps `Prompt` → `SuggestCommandPrompt` while set.
	 * Unmount resolves in-flight to `"cancelled"` so the tool promise
	 * settles cleanly. See `docs/AGENT-DESIGN.md` D15.
	 */
	pendingSuggestion: Accessor<PendingSuggestion | null>;
	respondSuggestion: (decision: SuggestCommandDecision) => void;
}

/**
 * Snapshot of an in-flight approval request, surfaced to
 * `PermissionPrompt` via `AgentContextValue.pendingApproval`. Carries
 * the display strings the panel renders and the `callId` the preview
 * registry keys by (so a consumer can explicitly cross-reference the
 * diff in the conversation if it wants, though today the diff
 * continues to render via `ToolPart` above the panel, not inside it).
 */
export interface PendingApproval {
	callId: string;
	title: string;
	message: string;
}

/**
 * In-flight `suggest_command` snapshot rendered by
 * `SuggestCommandPrompt`. `command` / `args` are schema-validated by
 * the backend factory.
 */
export interface PendingSuggestion {
	callId: string;
	command: string;
	args: string;
	rationale: string;
}

/**
 * Solid context carrying the provider value. Internal — consumers go
 * through `useAgent()`.
 */
export const agentContext = createContext<AgentContextValue>();
