/**
 * User-verb actions: `prompt`, `setModel`, `setThinkingLevel`,
 * `selectAgent`, `clearSession`, `resumeSession`. Extracted from
 * `agent.tsx` so the provider shell reads as composition only.
 *
 * Takes an `ActionDeps` bag over the session state, the backend
 * session, the store, and the toast/title-task surfaces. No top-level
 * module state; every piece of mutable lifetime data lives in
 * `SessionState`.
 */

import type { generateSessionTitle, Session } from "@backend/agent";
import {
	appendDisplayMessage,
	loadSession,
	newId,
	runInTransaction,
	safeRun,
	updateDisplayMessageMeta,
	updateSessionTitle,
} from "@backend/persistence/sessions";
import type {
	AgentStoreState,
	DisplayMessage,
	DisplayPart,
} from "@bridge/view-model";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getOpenAICodexWebSocketDebugStats } from "@mariozechner/pi-ai/openai-codex-responses";
import { batch } from "solid-js";
import { produce, type SetStoreFunction } from "solid-js/store";
import { toBottom } from "../../app";
import type { useToast } from "../../ui/toast";
import { closeSecondaryPage } from "../secondary-page";
import type { PreviewRegistry } from "./preview-registry";
import type { SessionState } from "./session-state";
import type { AgentContextValue, PendingApproval } from "./types";

export interface ActionDeps {
	agentSession: Session;
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
	sessionState: SessionState;
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
			// Resolve pending BEFORE backend abort — the run loop is
			// parked on `await confirmFn(...)` and AbortController
			// can't wake it. See `docs/APPROVAL-UI.md` § Abort / clear
			// ordering.
			if (deps.pendingApproval()) deps.respondApproval(false);
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
		},
		async clearSession() {
			await clearSessionAction(deps);
		},
		resumeSession(sessionId: string) {
			resumeSessionAction(sessionId, deps);
		},
	};
}

// ────────────────────────────────────────────────────────────────────
// prompt
// ────────────────────────────────────────────────────────────────────

async function promptAction(
	text: string,
	displayParts: DisplayPart[] | undefined,
	deps: ActionDeps,
): Promise<void> {
	const sessionId = deps.sessionState.ensureSession();
	const shouldGenerateTitle = deps.store.messages.length === 0;
	const titleProviderId = deps.store.modelProvider;
	const titleModelId = deps.agentSession.getModelId();
	// LLM text vs. bubble display split: when a command supplies
	// `displayParts` (reader's `/article` does), use those verbatim
	// so the bubble can render a file chip instead of the full
	// content; otherwise fall back to the one-text-part shape that
	// covers plain prompts. pi-agent-core only ever sees `text`, so
	// whatever the LLM needs must be in `text`.
	const userMsg: DisplayMessage = {
		id: newId(),
		role: "user",
		parts: displayParts ?? [{ type: "text", text }],
	};
	// Persist-first: push the user bubble, stamp the turn clock, and
	// start the LLM turn only if the insert committed. On failure,
	// `reportPersistenceError` has already toasted and `prompt.tsx`
	// has already cleared the input — the user retypes. Short-
	// circuiting here keeps store/disk in sync.
	let persisted = false;
	deps.sessionState.persistThen(
		(tx) => appendDisplayMessage(tx, sessionId, userMsg),
		() => {
			persisted = true;
			deps.setStore(
				"messages",
				produce((msgs: DisplayMessage[]) => {
					msgs.push(userMsg);
				}),
			);
			deps.setStore("lastTurnStartedAt", Date.now());
			// Snapshot the effort at turn-start so agent_end can stamp
			// the turn-closing bubble with the value that produced it,
			// not whatever the store holds at event time.
			deps.sessionState.setTurnStartThinkingLevel(deps.store.thinkingLevel);
			// Pre-turn snapshot of pi-ai's Codex WebSocket connection
			// counter. Read in `agent_end` to decide whether this turn
			// ran on WebSocket (counter advanced) or fell back to SSE
			// (counter unchanged). `getOpenAICodexWebSocketDebugStats`
			// returns `undefined` when no WebSocket has ever been
			// opened for this sessionId — we normalize to 0 so the
			// "no change" branch reads as "SSE used" on the first turn,
			// which is the correct semantic for a brand-new session
			// whose first turn couldn't open a WebSocket. Only
			// meaningful when Codex is the active provider; other
			// providers don't touch the counter, so the diff trivially
			// reads 0 — benign.
			if (deps.store.modelProvider === "openai-codex") {
				const stats = getOpenAICodexWebSocketDebugStats(sessionId);
				deps.sessionState.setPreTurnCodexConnections(
					(stats?.connectionsCreated ?? 0) + (stats?.connectionsReused ?? 0),
				);
			} else {
				deps.sessionState.setPreTurnCodexConnections(undefined);
			}
			if (shouldGenerateTitle) {
				startSessionTitleTask(
					{
						sessionId,
						activeProviderId: titleProviderId,
						activeModelId: titleModelId,
						prompt: text,
					},
					deps,
				);
			}
			toBottom();
		},
	);
	if (!persisted) return;
	// Guard against a pre-stream throw from `actions.prompt()`.
	// pi-agent-core funnels most provider errors through `message_end`
	// with `stopReason === "error"`, which the reducer already surfaces
	// onto the bubble. But failures *before* the first stream event —
	// `getApiKey()` rejection, a network error on the first request,
	// a thrown provider factory — bypass that path. Without a catch
	// here, `wrappedActions.prompt` rejects and the fire-and-forget
	// call sites in `prompt.tsx` turn into unhandled rejections that
	// can crash the process.
	try {
		await deps.agentSession.actions.prompt(text);
	} catch (err) {
		handlePreStreamError(err, deps);
	}
}

function startSessionTitleTask(
	params: {
		sessionId: string;
		activeProviderId: string;
		activeModelId: string;
		prompt: string;
	},
	deps: ActionDeps,
): void {
	void deps
		.titleGenerator(params)
		.then((title) => {
			if (!title) return;
			deps.sessionState.persistThen(
				(tx) => updateSessionTitle(tx, params.sessionId, title),
				() => {
					if (deps.sessionState.getCurrentSessionId() === params.sessionId) {
						deps.setStore("sessionTitle", title);
					}
				},
			);
		})
		.catch((error) => {
			// Expected title-gen failures (completeSimple throws on
			// primary and retry) are caught inside `generateSessionTitle`
			// and logged there with the resolved model ids. This outer
			// catch only fires on truly unexpected throws from
			// orchestration steps NOT wrapped by the inner try/catch —
			// e.g. `provider.getApiKey()` rejecting, or `loadConfig()`
			// throwing inside `resolveTitleModel`. Log the active params
			// so the next layer up has something to debug with.
			console.error(
				`[inkstone] session title task failed (active: ${params.activeProviderId}/${params.activeModelId}):`,
				error,
			);
		});
}

function handlePreStreamError(err: unknown, deps: ActionDeps): void {
	const msg = err instanceof Error ? err.message : String(err);
	batch(() => {
		deps.setStore("isStreaming", false);
		deps.setStore("status", "idle");
		const lastIdx = deps.store.messages.length - 1;
		const last = deps.store.messages[lastIdx];
		if (last && last.role === "assistant") {
			deps.setStore("messages", lastIdx, "error", msg);
			const updated = deps.store.messages[lastIdx];
			const sid = deps.sessionState.getCurrentSessionId();
			if (sid && updated) {
				// safeRun: no store state to gate. The in-memory bubble
				// already shows the error; a persistence failure here
				// just means the error won't appear on resume, which is
				// acceptable since the agent turn already failed.
				safeRun(() =>
					runInTransaction((tx) => updateDisplayMessageMeta(tx, sid, updated)),
				);
			}
		} else {
			// No assistant bubble was ever pushed (failure happened
			// before `message_start`). Append a synthetic one so the
			// error has a render target.
			const synthetic: DisplayMessage = {
				id: newId(),
				role: "assistant",
				parts: [],
				error: msg,
			};
			deps.setStore(
				"messages",
				produce((msgs: DisplayMessage[]) => {
					msgs.push(synthetic);
				}),
			);
			const sid = deps.sessionState.getCurrentSessionId();
			if (sid) {
				// safeRun: synthetic bubble is best-effort. If the insert
				// fails, the in-memory view still shows the error — resume
				// will miss this particular failure marker but the
				// session timeline stays valid.
				safeRun(() =>
					runInTransaction((tx) => appendDisplayMessage(tx, sid, synthetic)),
				);
			}
		}
	});
	deps.toast.show({
		variant: "error",
		title: "Agent error",
		message: msg,
		duration: 6000,
	});
}

// ────────────────────────────────────────────────────────────────────
// clearSession
// ────────────────────────────────────────────────────────────────────

async function clearSessionAction(deps: ActionDeps): Promise<void> {
	// Resolve pending approval before the backend call. See
	// `docs/APPROVAL-UI.md` § Abort / clear ordering.
	if (deps.pendingApproval()) deps.respondApproval(false);
	// Await the backend clear first. Mid-stream path: it calls
	// `agent.abort()` + `waitForIdle()` so pi-agent-core's final
	// `message_end` + `agent_end` events fire through the reducer
	// BEFORE we wipe the store here. That means the reducer's
	// `isStreaming = false` and the pending-tool-part sweep both
	// run against the still-populated store, then we clear it.
	// Swapping the order (store-wipe then await) would mean the
	// reducer's `setStore("messages", lastIdx, ...)` writes would
	// race against an empty `messages` array.
	await deps.agentSession.clearSession();
	// In-memory reset only. We no longer terminate the DB row —
	// `ended_at` is gone, and the future `/resume` command will list
	// past rows as-is. `currentSessionId = null` here just means the
	// NEXT prompt creates a fresh row.
	deps.sessionState.setCurrentSessionId(null);
	deps.setStore("messages", []);
	deps.setStore("sidebarSections", []);
	deps.setStore("sessionTitle", "inkstone");
	closeSecondaryPage();
	deps.setStore("totalTokens", 0);
	deps.setStore("totalCost", 0);
	deps.setStore("lastTurnStartedAt", 0);
	// Reset the Codex transport indicator. A fresh session gets a
	// fresh WebSocket cache key; no claim should carry over from
	// the previous session's network state.
	deps.setStore("codexTransport", undefined);
	deps.sessionState.setPreTurnCodexConnections(undefined);
	deps.previews.clearAll();
}

// ────────────────────────────────────────────────────────────────────
// resumeSession
// ────────────────────────────────────────────────────────────────────

function resumeSessionAction(sessionId: string, deps: ActionDeps): void {
	// Block during an in-flight turn. `isStreaming` is set on
	// `agent_start` and cleared on `agent_end` (which fires after
	// tool execution completes), so this one check covers both
	// streaming text and tool_executing status.
	if (deps.store.isStreaming) {
		deps.toast.show({
			variant: "warning",
			title: "Session busy",
			message: "Press Esc to stop the current turn, then try again.",
			duration: 4000,
		});
		return;
	}
	const loaded = loadSession(sessionId);
	if (!loaded) {
		deps.toast.show({
			variant: "error",
			title: "Session not found",
			message: `No session with id ${sessionId.slice(-8)}.`,
			duration: 4000,
		});
		return;
	}
	batch(() => {
		// Ordering matters. `agentSession.selectAgent` throws when
		// the live Agent's `messages.length > 0`; `clearSession`
		// wipes them first so the swap is always valid. Only then
		// do we seed the persisted history via `restoreMessages`.
		//
		// Cross-agent resume is intentional (see D13 in
		// `docs/AGENT-DESIGN.md`): the "one agent per session"
		// invariant covers a session's in-memory lifetime. Resume
		// constructs a fresh in-memory lifetime, so we rebind the
		// live Session onto the stored session's agent rather than
		// refusing.
		//
		// `agentSession.clearSession()` is async (see its doc), but
		// we've already guarded on `!store.isStreaming` above so
		// pi-agent-core has no `activeRun`; `waitForIdle()` short-
		// circuits and `reset()` is synchronous internally. The
		// returned Promise resolves with no side effects — fire-
		// and-forget is safe here because `batch()` can't contain
		// awaits and the idle path can't fail.
		void deps.agentSession.clearSession();
		if (loaded.session.agent !== deps.agentSession.agentName) {
			deps.agentSession.selectAgent(loaded.session.agent);
		}
		deps.agentSession.restoreMessages(loaded.agentMessages);
		deps.sessionState.setCurrentSessionId(loaded.session.id);
		// Forward the resumed session id so pi-ai's Codex cache keys
		// line up with this session's transcript on the first post-
		// resume turn. See `ensureSession` above for the full
		// rationale.
		deps.agentSession.setSessionId(loaded.session.id);
		deps.setStore("currentAgent", deps.agentSession.agentName);
		deps.setStore("messages", loaded.displayMessages);
		deps.setStore("sessionTitle", loaded.session.title);
		// Token / cost counters are seeded from the sum of per-turn
		// `AssistantMessage.usage` persisted on each assistant row in
		// `agent_messages`. Synthesized alternation-repair placeholders
		// have no `usage` and contribute 0; aborted turns with partial
		// usage do contribute (those tokens were really paid for).
		deps.setStore("totalTokens", loaded.totals.tokens);
		deps.setStore("totalCost", loaded.totals.cost);
		deps.setStore("lastTurnStartedAt", 0);
		// Ephemeral UI state — reset so the resumed session doesn't
		// inherit stale sidebar sections, secondary page, or a Codex
		// transport label from a previous process.
		deps.setStore("sidebarSections", []);
		closeSecondaryPage();
		deps.setStore("codexTransport", undefined);
		deps.sessionState.setPreTurnCodexConnections(undefined);
		// Wipe diff-preview archive — entries are keyed by callId and
		// must not bleed across resume boundaries.
		deps.previews.clearAll();
	});
	toBottom();
}
