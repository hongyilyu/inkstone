/**
 * Types + Solid context shape for `AgentProvider`. Split out of the
 * monolithic `agent.tsx` so the actions / reducer / commands / provider
 * modules can all import from one shared source of truth.
 */

import type { AgentActions, Session } from "@backend/agent";
import type { AgentStoreState, DisplayPart } from "@bridge/view-model";
import type {
	AgentEvent as AgentEventType,
	ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Accessor } from "solid-js";
import { createContext } from "solid-js";
import type { PreviewRegistry } from "./preview-registry";

/**
 * Factory signature for `AgentProvider`'s underlying `Session`. The
 * default value is `createAgentSession` from `@backend/agent`; tests
 * inject a fake that captures `onEvent` so synthetic `AgentEvent`s can
 * be emitted without a real pi-agent-core loop.
 */
export type SessionFactory = (params: {
	agentName?: string;
	onEvent: (event: AgentEventType) => void;
}) => Session;

export type { Session };

export interface AgentContextValue {
	store: AgentStoreState;
	actions: Omit<AgentActions, "prompt"> & {
		/**
		 * Send a user turn. `text` is the full payload pi-agent-core hands
		 * to pi-ai (and in turn to the LLM). `displayParts`, when supplied,
		 * replaces the default single-text-part rendering of the user
		 * bubble — used by commands like reader's `/article` that inline a
		 * large payload in `text` but want a compact bubble (short prose +
		 * file chip). When omitted, the bubble renders as `[{ type:
		 * "text", text }]`, matching the pre-displayParts shape.
		 */
		prompt(text: string, displayParts?: DisplayPart[]): Promise<void>;
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
 * Solid context carrying the provider value. Internal — consumers go
 * through `useAgent()`.
 */
export const agentContext = createContext<AgentContextValue>();
