import {
	type AgentActions,
	createAgentActions,
	getAgentInfo,
	getCurrentAgent,
	getCurrentModel,
	getCurrentThinkingLevel,
	setConfirmFn,
} from "@backend/agent";
import { setPersistenceErrorHandler } from "@backend/config/errors";
import {
	clearSession as clearSessionFile,
	loadSession,
	saveSession,
} from "@backend/config/session";
import type {
	AgentStoreState,
	DisplayMessage,
	DisplayPart,
} from "@bridge/view-model";
import type { AgentEvent, ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	getModel,
	type Model,
} from "@mariozechner/pi-ai";
import { batch, createContext, type ParentProps, useContext } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { toBottom } from "../app";

/**
 * Placeholder strings that providers inject into redacted thinking blocks.
 * When a `thinking_end` arrives and the accumulated text consists solely of
 * one of these placeholders (possibly with surrounding whitespace), the
 * thinking part is dropped from the message — it carries no user-visible
 * information and would otherwise persist as a dead breadcrumb.
 *
 * - `[REDACTED]`                    — OpenRouter literal (all providers)
 * - `Reasoning hidden by provider`  — pi-kiro slow-path marker (conformance §26a)
 */
const REDACTED_THINKING_PLACEHOLDERS = [
	"[REDACTED]",
	"Reasoning hidden by provider",
] as const;

import { useDialog } from "../ui/dialog";
import { DialogConfirm } from "../ui/dialog-confirm";
import { useToast } from "../ui/toast";

interface AgentContextValue {
	store: AgentStoreState;
	actions: AgentActions;
}

const ctx = createContext<AgentContextValue>();

let messageCounter = 0;

/**
 * Migrate a persisted `DisplayMessage` from the old `text: string` shape to
 * the current `parts: DisplayPart[]` shape. Sessions saved before the parts
 * change come back off disk with `(msg as any).text` populated and no
 * `parts` field; we rebuild a single text part so the bubble renders without
 * a render-path crash. Messages already in the new shape pass through
 * untouched. The legacy `text` field is explicitly dropped so it doesn't
 * round-trip through `saveSession`.
 */
function migrateMessage(msg: DisplayMessage): DisplayMessage {
	if (Array.isArray(msg.parts)) return msg;
	const { text: legacyText, ...rest } = msg as DisplayMessage & {
		text?: string;
	};
	return {
		...rest,
		parts: legacyText ? [{ type: "text", text: legacyText }] : [],
	};
}

export function AgentProvider(props: ParentProps) {
	const dialog = useDialog();
	const toast = useToast();

	setConfirmFn(async (title, message) => {
		const result = await DialogConfirm.show(dialog, title, message);
		return result === true;
	});

	// Route backend persistence write failures (disk-full, permission-denied,
	// read-only filesystem) through the toast surface. The backend calls
	// `reportPersistenceError`, which fans out to this handler; without a
	// handler it falls back to `console.error` so the failure is never silent.
	setPersistenceErrorHandler(({ kind, action, error }) => {
		const msg = error instanceof Error ? error.message : String(error);
		toast.show({
			variant: "error",
			title: `${kind === "config" ? "Config" : "Session"} ${action} failed`,
			message: msg,
			duration: 6000,
		});
	});

	// Restore previous session if available
	const saved = loadSession();

	// Get initial model info
	const initialModel = getCurrentModel();

	const [store, setStore] = createStore<AgentStoreState>({
		messages: (saved?.messages ?? []).map(migrateMessage),
		isStreaming: false,
		activeArticle: saved?.activeArticle ?? null,
		modelName: initialModel.name,
		modelProvider: initialModel.provider,
		contextWindow: initialModel.contextWindow,
		modelReasoning: initialModel.reasoning,
		thinkingLevel: getCurrentThinkingLevel(),
		status: "idle",
		totalTokens: 0,
		totalCost: 0,
		lastTurnStartedAt: 0,
		currentAgent: getCurrentAgent(),
	});

	// Set message counter past any restored messages
	if (saved?.messages) {
		messageCounter = saved.messages.length;
	}

	const actions = createAgentActions((event: AgentEvent) => {
		batch(() => {
			switch (event.type) {
				case "agent_start":
					setStore("isStreaming", true);
					setStore("status", "streaming");
					// A fresh assistant display bubble is pushed per-boundary on
					// `message_start` so tool-driven turns with multiple assistant
					// messages keep their footer metadata separate.
					toBottom();
					break;

				case "message_start": {
					const msg = (event as any).message;
					if (msg && msg.role === "assistant") {
						setStore(
							"messages",
							produce((msgs: DisplayMessage[]) => {
								msgs.push({
									id: `msg-${++messageCounter}`,
									role: "assistant",
									parts: [],
								});
							}),
						);
						toBottom();
					}
					break;
				}

				case "message_update": {
					// pi-ai's `AssistantMessageEvent` union fires `text_start` /
					// `thinking_start` deterministically before the first matching
					// delta (see pi-agent-core `agent-loop.js:175-190`). We still
					// runtime-guard the tail-part type in each delta arm — cheap
					// insurance against future upstream reordering, and it's the
					// single failure mode that would silently cross-append text
					// into a thinking block (or vice versa).
					if (!("assistantMessageEvent" in event)) break;
					const ame = (
						event as { assistantMessageEvent?: AssistantMessageEvent }
					).assistantMessageEvent;
					if (!ame) break;
					const lastMsgIdx = store.messages.length - 1;
					if (lastMsgIdx < 0) break;

					switch (ame.type) {
						case "text_start":
							setStore(
								"messages",
								lastMsgIdx,
								"parts",
								produce((parts: DisplayPart[]) => {
									parts.push({ type: "text", text: "" });
								}),
							);
							break;
						case "thinking_start":
							setStore(
								"messages",
								lastMsgIdx,
								"parts",
								produce((parts: DisplayPart[]) => {
									parts.push({ type: "thinking", text: "" });
								}),
							);
							break;
						case "text_delta":
						case "thinking_delta": {
							if (!ame.delta) break;
							const lastMsg = store.messages[lastMsgIdx];
							if (!lastMsg) break;
							const lastPartIdx = lastMsg.parts.length - 1;
							const lastPart = lastMsg.parts[lastPartIdx];
							if (!lastPart) break;
							const expected = ame.type === "text_delta" ? "text" : "thinking";
							if (lastPart.type !== expected) break;
							setStore(
								"messages",
								lastMsgIdx,
								"parts",
								lastPartIdx,
								"text",
								(t) => t + ame.delta,
							);
							break;
						}
						case "thinking_end": {
							// Drop the part if nothing renderable accumulated.
							// Several redacted-thinking shapes land here:
							//   - Anthropic `redacted: true` — pi-ai emits no
							//     `thinking_delta` at all, so `text` is "".
							//   - OpenRouter's `[REDACTED]` literal — arrives as a
							//     delta chunk and would otherwise render verbatim
							//     (`"[REDACTED]".trim()` is truthy).
							//   - pi-kiro's `Reasoning hidden by provider` — slow-path
							//     marker per conformance §26a; same shape as above.
							// Strip all known placeholders before the trim so every
							// case collapses to empty and gets popped. OpenCode
							// filters the same literal at render time
							// (`routes/session/index.tsx:1443`); we do it reducer-side
							// because Inkstone has no `showThinking` toggle, so a
							// stored-but-never-rendered part would just be dead weight
							// in persistence.
							const lastMsg = store.messages[lastMsgIdx];
							if (!lastMsg) break;
							const lastPartIdx = lastMsg.parts.length - 1;
							const lastPart = lastMsg.parts[lastPartIdx];
							if (!lastPart || lastPart.type !== "thinking") break;
							const stripped = REDACTED_THINKING_PLACEHOLDERS.reduce(
								(s, p) => s.replace(p, ""),
								lastPart.text,
							);
							if (!stripped.trim()) {
								setStore(
									"messages",
									lastMsgIdx,
									"parts",
									produce((p: DisplayPart[]) => {
										p.pop();
									}),
								);
							}
							break;
						}
						// Other `AssistantMessageEvent` variants (`start`,
						// `text_end`, `toolcall_*`, `done`, `error`) are
						// intentionally ignored — `text_end` is a no-op for us
						// (deltas already built the part), tool-call rendering
						// isn't wired in display bubbles yet, and stream
						// lifecycle is handled by `message_start` / `message_end`
						// / `agent_end` on the outer `AgentEvent`.
						default:
							break;
					}
					break;
				}

				case "message_end": {
					// Accumulate token usage and cost from assistant messages
					const msg = (event as any).message;
					if (msg && msg.role === "assistant") {
						const assistantMsg = msg as AssistantMessage;
						const usage = assistantMsg.usage;
						if (usage) {
							setStore("totalTokens", (t) => t + usage.totalTokens);
							setStore("totalCost", (c) => c + usage.cost.total);
						}
						// Snapshot agent + model onto the assistant bubble that was
						// pushed in the matching `message_start`. Sourcing provider/model
						// from the event (not `store.modelName`) means mid-run Ctrl+P
						// model switches don't relabel an already-generated reply, and
						// tool-driven turns with multiple assistant messages get their
						// own correct per-bubble footer.
						const lastIdx = store.messages.length - 1;
						const last = store.messages[lastIdx];
						if (last && last.role === "assistant") {
							const provider = assistantMsg.provider;
							const modelId = assistantMsg.model;
							const displayName =
								getModel(provider as any, modelId as any)?.name ?? modelId;
							// Switching agents is locked to the empty-session open
							// page, so `store.currentAgent` at event time is
							// guaranteed to be the agent that produced this reply.
							const agentName = getAgentInfo(store.currentAgent).displayName;
							setStore("messages", lastIdx, "agentName", agentName);
							setStore("messages", lastIdx, "modelName", displayName);
							// Surface any assistant-turn failure onto the bubble. pi-ai
							// converts provider SDK exceptions into stream `error` events
							// (see amazon-bedrock.js:164-167) which pi-agent-core forwards
							// through message_end with `stopReason` set and `errorMessage`
							// populated. Without this stash the errored bubble renders as
							// empty text with no user-facing hint that anything went wrong.
							if (
								(assistantMsg.stopReason === "error" ||
									assistantMsg.stopReason === "aborted") &&
								assistantMsg.errorMessage
							) {
								setStore(
									"messages",
									lastIdx,
									"error",
									assistantMsg.errorMessage,
								);
							}
						}
					}
					break;
				}

				case "tool_execution_start":
					setStore("status", "tool_executing");
					break;

				case "agent_end":
					setStore("isStreaming", false);
					setStore("status", "idle");
					// `duration` is a per-turn value. `agent_end` fires immediately after
					// the turn-closing assistant `message_end`, and tool results are not
					// rendered as display bubbles, so `messages[length - 1]` at this
					// point is guaranteed to be the turn-closing assistant bubble. That
					// bubble gets the stamp; intermediate tool-call assistant messages
					// in the same turn correctly do not.
					if (store.lastTurnStartedAt > 0) {
						const duration = Date.now() - store.lastTurnStartedAt;
						const lastIdx = store.messages.length - 1;
						const last = store.messages[lastIdx];
						if (last && last.role === "assistant") {
							setStore("messages", lastIdx, "duration", duration);
						}
					}
					// Persist session after each turn
					saveSession({
						messages: [...store.messages],
						activeArticle: store.activeArticle,
						currentAgent: store.currentAgent,
					});
					break;
			}
		});
	});

	// Wrap prompt to add the user message to the store before calling the agent
	const wrappedActions: AgentActions = {
		...actions,
		async prompt(text: string) {
			setStore(
				"messages",
				produce((msgs: DisplayMessage[]) => {
					msgs.push({
						id: `msg-${++messageCounter}`,
						role: "user",
						parts: [{ type: "text", text }],
					});
				}),
			);
			setStore("lastTurnStartedAt", Date.now());
			toBottom();
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
				await actions.prompt(text);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				batch(() => {
					setStore("isStreaming", false);
					setStore("status", "idle");
					const lastIdx = store.messages.length - 1;
					const last = store.messages[lastIdx];
					if (last && last.role === "assistant") {
						setStore("messages", lastIdx, "error", msg);
					} else {
						// No assistant bubble was ever pushed (failure happened
						// before `message_start`). Append a synthetic one so the
						// error has a render target.
						setStore(
							"messages",
							produce((msgs: DisplayMessage[]) => {
								msgs.push({
									id: `msg-${++messageCounter}`,
									role: "assistant",
									parts: [],
									error: msg,
								});
							}),
						);
					}
				});
				toast.show({
					variant: "error",
					title: "Agent error",
					message: msg,
					duration: 6000,
				});
			}
		},
		loadArticle(articleId: string) {
			actions.loadArticle(articleId);
			setStore("activeArticle", articleId);
		},
		setModel(model: Model<Api>) {
			actions.setModel(model);
			setStore("modelName", model.name);
			setStore("modelProvider", model.provider);
			setStore("contextWindow", model.contextWindow);
			setStore("modelReasoning", model.reasoning);
			// Backend `setModel` also re-applies the per-model stored
			// thinkingLevel (or "off") onto the agent state, so surface that
			// into the store at the same time — otherwise the status-line
			// suffix would lag a model switch by one interaction.
			setStore("thinkingLevel", getCurrentThinkingLevel());
		},
		setThinkingLevel(level: ThinkingLevel) {
			actions.setThinkingLevel(level);
			setStore("thinkingLevel", level);
		},
		setAgent(name: string) {
			actions.setAgent(name);
			// Read back the canonical name (the registry may coerce unknown names
			// to the default agent) so the UI stays consistent with the backend.
			setStore("currentAgent", getCurrentAgent());
		},
		clearSession() {
			actions.clearSession();
			setStore("messages", []);
			setStore("activeArticle", null);
			setStore("totalTokens", 0);
			setStore("totalCost", 0);
			setStore("lastTurnStartedAt", 0);
			clearSessionFile();
			messageCounter = 0;
		},
	};

	const value: AgentContextValue = { store, actions: wrappedActions };

	// Restore the agent recorded in the saved session *before* loadArticle, so
	// the system-prompt rebuild inside `loadArticle` runs under the correct
	// agent's prompt builder. Without this, a transcript persisted under one
	// agent could reopen under whichever agent is currently in `config.json`,
	// with no way to switch back (agent cycling is locked once messages exist).
	// Legacy sessions that predate the field fall through and use config.
	if (saved?.currentAgent) {
		wrappedActions.setAgent(saved.currentAgent);
	}

	// Reactivate article-specific system prompt / guard in the agent runtime
	// if a previous session had an active article.
	if (saved?.activeArticle) {
		actions.loadArticle(saved.activeArticle);
	}

	return <ctx.Provider value={value}>{props.children}</ctx.Provider>;
}

export function useAgent() {
	const value = useContext(ctx);
	if (!value) throw new Error("useAgent must be used within an AgentProvider");
	return value;
}
