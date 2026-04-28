import {
	type AgentActions,
	createSession as createAgentSession,
	getAgentInfo,
	setConfirmFn,
} from "@backend/agent";
import { setPersistenceErrorHandler } from "@backend/persistence/errors";
import {
	appendAgentMessage,
	appendDisplayMessage,
	createSession,
	finalizeDisplayMessageParts,
	newId,
	runInTransaction,
	updateDisplayMessageMeta,
} from "@backend/persistence/sessions";
import type {
	AgentStoreState,
	DisplayMessage,
	DisplayPart,
} from "@bridge/view-model";
import type {
	AgentEvent,
	AgentMessage,
	ThinkingLevel,
} from "@mariozechner/pi-agent-core";
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
import { type CommandOption, useCommand } from "../components/dialog-command";

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
	actions: AgentActions & { selectAgent(name: string): void };
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
	};
}

const ctx = createContext<AgentContextValue>();

export function AgentProvider(props: ParentProps) {
	const dialog = useDialog();
	const toast = useToast();

	setConfirmFn(async (title, message) => {
		const result = await DialogConfirm.show(dialog, title, message);
		return result === true;
	});

	// Route backend persistence write failures (disk-full, permission-denied,
	// read-only filesystem, DB I/O errors) through the toast surface. Without
	// a handler the backend falls back to `console.error`, so the failure is
	// never silent.
	setPersistenceErrorHandler(({ kind, action, error }) => {
		const msg = error instanceof Error ? error.message : String(error);
		const titleKind =
			kind === "config" ? "Config" : kind === "auth" ? "Auth" : "Session";
		toast.show({
			variant: "error",
			title: `${titleKind} ${action} failed`,
			message: msg,
			duration: 6000,
		});
	});

	// Build the one session this provider owns. Boot always shows the
	// openpage — no auto-resume. Past session rows stay on disk for a
	// future `/resume` command (not yet built). See D13 in
	// `docs/AGENT-DESIGN.md`: agent is fixed for a session's lifetime.
	const agentSession = createAgentSession({
		onEvent: (event: AgentEvent) => onAgentEvent(event),
	});

	// Mutable DB row handle. Lazily created on first user prompt to
	// avoid churning empty rows when the user boots without interacting.
	let currentSessionId: string | null = null;

	const initialModel = agentSession.getModel();

	const [store, setStore] = createStore<AgentStoreState>({
		messages: [],
		isStreaming: false,
		modelName: initialModel.name,
		modelProvider: initialModel.provider,
		contextWindow: initialModel.contextWindow,
		modelReasoning: initialModel.reasoning,
		thinkingLevel: agentSession.getThinkingLevel(),
		status: "idle",
		totalTokens: 0,
		totalCost: 0,
		lastTurnStartedAt: 0,
		currentAgent: agentSession.agentName,
	});

	/**
	 * Ensure we have a session row to write to. Called from inside the
	 * user-prompt path (before we push the user bubble) so only actually
	 * active sessions get rows.
	 *
	 * Invariant: every `AgentEvent` we receive runs after a user prompt,
	 * and that prompt calls `ensureSession()` synchronously before pushing
	 * the user bubble. Therefore `currentSessionId` is guaranteed non-null
	 * inside every branch of the reducer below — the guards are defensive,
	 * not structural.
	 */
	function ensureSession(): string {
		if (currentSessionId) return currentSessionId;
		const rec = createSession({
			agent: store.currentAgent,
		});
		currentSessionId = rec.id;
		return rec.id;
	}

	function onAgentEvent(event: AgentEvent) {
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
						const newMsg: DisplayMessage = {
							id: newId(),
							role: "assistant",
							parts: [],
						};
						setStore(
							"messages",
							produce((msgs: DisplayMessage[]) => {
								msgs.push(newMsg);
							}),
						);
						// Insert the header row only — parts stream in and get
						// flushed as a batch on `message_end` via
						// `finalizeDisplayMessageParts`. Avoids the old
						// DELETE+re-INSERT thrash that ran on every end event.
						//
						// `currentSessionId` is guaranteed non-null: this branch
						// only fires during a turn, and turns only start via
						// `wrappedActions.prompt` which called `ensureSession()`.
						//
						// One-statement wrap in `runInTransaction` — the writer
						// API requires a tx; this single insert is atomic by
						// nature, so we wrap the one call instead of aggregating
						// with message_end (which is on a separate event loop
						// tick).
						if (currentSessionId) {
							const sid = currentSessionId;
							runInTransaction((tx) =>
								appendDisplayMessage(tx, sid, newMsg, {
									includeParts: false,
								}),
							);
						}
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
							// case collapses to empty and gets popped.
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
					const msg = (event as any).message as AgentMessage | undefined;
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
							// Commit the three related artifacts (header meta, parts,
							// raw AgentMessage) in a single transaction so a crash
							// between them can't leave the session in a half-written
							// state. Eliminates the repair path for new corruption.
							if (currentSessionId) {
								const sid = currentSessionId;
								const updated = store.messages[lastIdx];
								if (updated) {
									runInTransaction((tx) => {
										updateDisplayMessageMeta(tx, sid, updated);
										finalizeDisplayMessageParts(tx, sid, updated);
										appendAgentMessage(tx, sid, msg, {
											displayMessageId: updated.id,
										});
									});
								}
							}
						}
					} else if (msg && currentSessionId) {
						// Tool-result / user / custom messages — persist so the
						// raw-message timeline is complete for resume. No display
						// bubble, so `displayMessageId` stays NULL.
						const sid = currentSessionId;
						runInTransaction((tx) => appendAgentMessage(tx, sid, msg));
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
							const updated = store.messages[lastIdx];
							if (currentSessionId && updated) {
								const sid = currentSessionId;
								runInTransaction((tx) =>
									updateDisplayMessageMeta(tx, sid, updated),
								);
							}
						}
					}
					break;
			}
		});
	}

	// Wrap prompt to add the user message to the store before calling
	// the agent. Also owns the TUI-only `selectAgent` verb that swaps
	// the in-flight agent on an empty session (throws otherwise — see
	// D13 in `docs/AGENT-DESIGN.md`).
	const wrappedActions: AgentContextValue["actions"] = {
		...agentSession.actions,
		async prompt(text: string) {
			const sessionId = ensureSession();
			const userMsg: DisplayMessage = {
				id: newId(),
				role: "user",
				parts: [{ type: "text", text }],
			};
			setStore(
				"messages",
				produce((msgs: DisplayMessage[]) => {
					msgs.push(userMsg);
				}),
			);
			setStore("lastTurnStartedAt", Date.now());
			runInTransaction((tx) => appendDisplayMessage(tx, sessionId, userMsg));
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
				await agentSession.actions.prompt(text);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				batch(() => {
					setStore("isStreaming", false);
					setStore("status", "idle");
					const lastIdx = store.messages.length - 1;
					const last = store.messages[lastIdx];
					if (last && last.role === "assistant") {
						setStore("messages", lastIdx, "error", msg);
						const updated = store.messages[lastIdx];
						if (currentSessionId && updated) {
							const sid = currentSessionId;
							runInTransaction((tx) =>
								updateDisplayMessageMeta(tx, sid, updated),
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
						setStore(
							"messages",
							produce((msgs: DisplayMessage[]) => {
								msgs.push(synthetic);
							}),
						);
						if (currentSessionId) {
							const sid = currentSessionId;
							runInTransaction((tx) =>
								appendDisplayMessage(tx, sid, synthetic),
							);
						}
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
		setModel(model: Model<Api>) {
			agentSession.actions.setModel(model);
			setStore("modelName", model.name);
			setStore("modelProvider", model.provider);
			setStore("contextWindow", model.contextWindow);
			setStore("modelReasoning", model.reasoning);
			// Backend `setModel` also re-applies the per-model stored
			// thinkingLevel (or "off") onto the agent state, so surface that
			// into the store at the same time — otherwise the status-line
			// suffix would lag a model switch by one interaction.
			setStore("thinkingLevel", agentSession.getThinkingLevel());
		},
		setThinkingLevel(level: ThinkingLevel) {
			agentSession.actions.setThinkingLevel(level);
			setStore("thinkingLevel", level);
		},
		selectAgent(name: string) {
			// Agent-for-life invariant: swapping with messages in flight
			// would silently break prompt-cache stability (systemPrompt +
			// tools change mid-conversation) and scramble bubble agent
			// stamps. The backend throws on non-empty; we check here too
			// so the error surfaces before any UI state mutation.
			// See D13 in `docs/AGENT-DESIGN.md`.
			if (store.messages.length > 0) {
				throw new Error(
					"Agent is fixed for the lifetime of a session. " +
						"Use /clear before selecting a different agent.",
				);
			}
			agentSession.selectAgent(name);
			setStore("currentAgent", agentSession.agentName);
		},
		clearSession() {
			agentSession.actions.clearSession();
			// In-memory reset only. We no longer terminate the DB row —
			// `ended_at` is gone, and the future `/resume` command will
			// list past rows as-is. `currentSessionId = null` here just
			// means the NEXT prompt creates a fresh row.
			currentSessionId = null;
			setStore("messages", []);
			setStore("totalTokens", 0);
			setStore("totalCost", 0);
			setStore("lastTurnStartedAt", 0);
		},
	};

	const value: AgentContextValue = {
		store,
		actions: wrappedActions,
		session: {
			getModel: () => agentSession.getModel(),
			getProviderId: () => agentSession.getProviderId(),
			getModelId: () => agentSession.getModelId(),
			getThinkingLevel: () => agentSession.getThinkingLevel(),
		},
	};

	/**
	 * Bridge backend-declared `AgentCommand`s into the unified command
	 * registry. Defined as a closure component so it can capture
	 * `wrappedActions` without widening the `useAgent()` context value.
	 * Mounts as a child of `<ctx.Provider>` so it has an owner for
	 * `onCleanup` and is inside `CommandProvider` (which wraps
	 * `AgentProvider` at the app root).
	 *
	 * Reactive on `store.currentAgent`: the registration callback re-runs
	 * when the user switches agents, so an agent's slash verbs only
	 * match while that agent is active.
	 *
	 * Argful commands (`takesArgs`) register with `hidden: true` so they
	 * don't appear in the Ctrl+P palette — palette-click can't supply
	 * arguments, so showing them would be misleading. They're still
	 * slash-dispatched through the prompt.
	 *
	 * Agent-bridge registrations sit ahead of shell registrations in the
	 * registry's `entries` list (AgentProvider mounts inside
	 * CommandProvider, and `register` prepends to the list), so on slash-
	 * name collision the agent-scoped entry wins — preserves D9's
	 * "agent overrides built-in" rule.
	 */
	function BridgeAgentCommands() {
		const command = useCommand();
		command.register((): CommandOption[] => {
			const info = getAgentInfo(store.currentAgent);
			if (!info.commands || info.commands.length === 0) return [];
			return info.commands.map((c) => ({
				id: `agent.${info.name}.${c.name}`,
				title: `/${c.name}${c.argHint ? ` ${c.argHint}` : ""}`,
				description: c.description,
				hidden: !!c.takesArgs,
				slash: {
					name: c.name,
					takesArgs: c.takesArgs,
					argHint: c.argHint,
				},
				onSelect: (_d, args) => {
					// Fire-and-forget. Errors thrown before `prompt(...)` runs
					// (e.g. reader's `/article missing.md` throws during file
					// validation, before any agent turn starts) bypass the
					// prompt wrapper's catch — so we handle rejections here
					// directly and surface a toast. Errors raised *during* a
					// streaming turn still flow through `wrappedActions.prompt`
					// and land on the in-flight bubble as usual.
					// `execute` may return `void` (sync commands); wrap in
					// Promise.resolve so `.catch` is always available.
					Promise.resolve(
						c.execute(args ?? "", (text) => wrappedActions.prompt(text)),
					).catch((err: unknown) => {
						const msg = err instanceof Error ? err.message : String(err);
						toast.show({
							variant: "error",
							title: "Command error",
							message: msg,
							duration: 6000,
						});
					});
				},
			}));
		});
		return null;
	}

	return (
		<ctx.Provider value={value}>
			<BridgeAgentCommands />
			{props.children}
		</ctx.Provider>
	);
}

export function useAgent() {
	const value = useContext(ctx);
	if (!value) throw new Error("useAgent must be used within an AgentProvider");
	return value;
}
