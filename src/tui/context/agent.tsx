import {
	type AgentActions,
	createAgentActions,
	getAgentInfo,
	getCurrentAgent,
	getCurrentModel,
	getCurrentThinkingLevel,
	setConfirmFn,
} from "@backend/agent";
import {
	clearSession as clearSessionFile,
	loadSession,
	saveSession,
} from "@backend/persistence/session";
import type { AgentStoreState, DisplayMessage } from "@bridge/view-model";
import type { AgentEvent, ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	getModel,
	type Model,
} from "@mariozechner/pi-ai";
import { batch, createContext, type ParentProps, useContext } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { toBottom } from "../app";
import { useDialog } from "../ui/dialog";
import { DialogConfirm } from "../ui/dialog-confirm";

interface AgentContextValue {
	store: AgentStoreState;
	actions: AgentActions;
}

const ctx = createContext<AgentContextValue>();

let messageCounter = 0;

export function AgentProvider(props: ParentProps) {
	const dialog = useDialog();

	setConfirmFn(async (title, message) => {
		const result = await DialogConfirm.show(dialog, title, message);
		return result === true;
	});

	// Restore previous session if available
	const saved = loadSession();

	// Get initial model info
	const initialModel = getCurrentModel();

	const [store, setStore] = createStore<AgentStoreState>({
		messages: saved?.messages ?? [],
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
									text: "",
								});
							}),
						);
						toBottom();
					}
					break;
				}

				case "message_update":
					if (
						"assistantMessageEvent" in event &&
						(event as any).assistantMessageEvent?.type === "text_delta"
					) {
						const delta = (event as any).assistantMessageEvent.delta as string;
						// Append delta to the last message's text — no array replacement
						setStore(
							"messages",
							store.messages.length - 1,
							"text",
							(t) => t + delta,
						);
					}
					break;

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
					msgs.push({ id: `msg-${++messageCounter}`, role: "user", text });
				}),
			);
			setStore("lastTurnStartedAt", Date.now());
			toBottom();
			await actions.prompt(text);
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
