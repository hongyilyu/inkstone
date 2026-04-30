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
	loadSession,
	newId,
	runInTransaction,
	updateDisplayMessageMeta,
} from "@backend/persistence/sessions";
import type {
	AgentStoreState,
	DisplayMessage,
	DisplayPart,
	SidebarSection,
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
import { closeSecondaryPage } from "./secondary-page";
import { type CommandOption, useCommand } from "../components/dialog-command";
import { DialogSelect } from "../ui/dialog-select";

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
		clearSession(): void;
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
		sidebarSections: [],
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
							// Narrow through `produce` because Solid's store
							// path typing can't see the runtime `lastPart.type`
							// guard above — addressing `"text"` on the union
							// `text | thinking | file` would fail typecheck
							// even though the runtime guard makes it safe.
							setStore(
								"messages",
								lastMsgIdx,
								"parts",
								lastPartIdx,
								produce((p: DisplayPart) => {
									if (p.type === "text" || p.type === "thinking") {
										p.text += ame.delta;
									}
								}),
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

				case "tool_execution_end": {
					// Handle update_sidebar tool — apply the structured details
					// to the store so the sidebar reacts immediately.
					const endEvt = event as {
						type: "tool_execution_end";
						toolName: string;
						result: any;
					};
					if (endEvt.toolName === "update_sidebar" && endEvt.result?.details) {
						const d = endEvt.result.details as {
							operation: "upsert" | "delete";
							id: string;
							title?: string;
							content?: string;
						};
						if (d.operation === "delete") {
							setStore(
								"sidebarSections",
								(sections) => sections.filter((s) => s.id !== d.id),
							);
						} else if (d.operation === "upsert" && d.title && d.content) {
							const title = d.title;
							const content = d.content;
							setStore(
								"sidebarSections",
								produce((sections: SidebarSection[]) => {
									const idx = sections.findIndex((s) => s.id === d.id);
									const entry: SidebarSection = {
										id: d.id,
										title,
										content,
									};
									if (idx >= 0) {
										sections[idx] = entry;
									} else {
										sections.push(entry);
									}
								}),
							);
						}
					}
					break;
				}

				case "agent_end":
					setStore("isStreaming", false);
					setStore("status", "idle");
					// Persist any closing assistant AgentMessage that
					// `handleRunFailure` synthesized on abort/error.
					// pi-agent-core's `handleRunFailure` pushes a synthetic
					// `{ role: "assistant", stopReason: "aborted"|"error" }`
					// into `_state.messages` and emits **only** `agent_end`
					// — no `message_end` — so our normal persistence path
					// (which writes to `agent_messages` inside `message_end`)
					// misses it. Without this catch-up write, the next
					// prompt on this session hands the provider
					// `[..., user, user]`: Anthropic silently merges
					// consecutive user turns; Bedrock 400s. `agent_end`
					// carries the synthesized message(s) in its `messages`
					// array — see `handleRunFailure` in pi-agent-core
					// `agent.js:326-341`. We append any message from that
					// array that wasn't already persisted via the normal
					// `message_end` path.
					{
						const endedMsgs = (event as { messages?: AgentMessage[] }).messages;
						if (endedMsgs && endedMsgs.length > 0 && currentSessionId) {
							const sid = currentSessionId;
							runInTransaction((tx) => {
								for (const m of endedMsgs) {
									if (!m) continue;
									if (
										m.role === "assistant" &&
										(m.stopReason === "aborted" || m.stopReason === "error")
									) {
										appendAgentMessage(tx, sid, m);
									}
								}
							});
						}
					}
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

	// Wrap per-turn actions with TUI-specific side effects (push user
	// bubble, sync store fields). Also owns the TUI-only lifecycle
	// verbs `selectAgent` and `clearSession` that bridge Session's
	// lifecycle methods with store resets.
	const wrappedActions: AgentContextValue["actions"] = {
		...agentSession.actions,
		async prompt(text: string, displayParts?: DisplayPart[]) {
			const sessionId = ensureSession();
			// LLM text vs. bubble display split: when a command supplies
			// `displayParts` (reader's `/article` does), use those verbatim
			// so the bubble can render a file chip instead of the full
			// content; otherwise fall back to the one-text-part shape
			// that covers plain prompts. pi-agent-core only ever sees
			// `text`, so whatever the LLM needs must be in `text`.
			const userMsg: DisplayMessage = {
				id: newId(),
				role: "user",
				parts: displayParts ?? [{ type: "text", text }],
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
			agentSession.clearSession();
			// In-memory reset only. We no longer terminate the DB row —
			// `ended_at` is gone, and the future `/resume` command will
			// list past rows as-is. `currentSessionId = null` here just
			// means the NEXT prompt creates a fresh row.
			currentSessionId = null;
			setStore("messages", []);
			setStore("sidebarSections", []);
			closeSecondaryPage();
			setStore("totalTokens", 0);
			setStore("totalCost", 0);
			setStore("lastTurnStartedAt", 0);
		},
		resumeSession(sessionId: string) {
			// Block during an in-flight turn. `isStreaming` is set on
			// `agent_start` and cleared on `agent_end` (which fires after
			// tool execution completes), so this one check covers both
			// streaming text and tool_executing status.
			if (store.isStreaming) {
				toast.show({
					variant: "warning",
					title: "Session busy",
					message: "Press Esc to stop the current turn, then try again.",
					duration: 4000,
				});
				return;
			}
			const loaded = loadSession(sessionId);
			if (!loaded) {
				toast.show({
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
				agentSession.clearSession();
				if (loaded.session.agent !== agentSession.agentName) {
					agentSession.selectAgent(loaded.session.agent);
				}
				agentSession.restoreMessages(loaded.agentMessages);
				currentSessionId = loaded.session.id;
				setStore("currentAgent", agentSession.agentName);
				setStore("messages", loaded.displayMessages);
				// Token / cost counters are session-local accumulators built
				// from streaming events. They aren't persisted, so a resumed
				// session starts from zero; the right Sidebar's `hasUsageData`
				// memo already hides the usage block when both are zero, so
				// the resumed view won't misreport "0 spent" next to N prior
				// turns.
				setStore("totalTokens", 0);
				setStore("totalCost", 0);
				setStore("lastTurnStartedAt", 0);
				// Ephemeral UI state — reset so the resumed session doesn't
				// inherit stale sidebar sections or secondary page.
				setStore("sidebarSections", []);
				closeSecondaryPage();
			});
			toBottom();
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
			getCurrentSessionId: () => currentSessionId,
		},
	};

	/**
	 * Build the `AgentCommandHelpers` bag injected into every
	 * `AgentCommand.execute` call. Closes over `wrappedActions`,
	 * `dialog`, and the store so commands can push display bubbles
	 * and open picker dialogs without knowing about the TUI layer.
	 */
	function buildCommandHelpers(): import("@backend/agent/types").AgentCommandHelpers {
		return {
			// Forward the optional `displayParts` so commands like reader's
			// `/article` can render a compact bubble while pi-agent-core
			// still receives the full-content `text`. See
			// `wrappedActions.prompt` for the split; pi-agent-core is blind
			// to `displayParts` by construction — it lives entirely in the
			// Solid store.
			prompt: (text, displayParts) => wrappedActions.prompt(text, displayParts),
			displayMessage(text: string) {
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
				runInTransaction((tx) => appendDisplayMessage(tx, sessionId, userMsg));
				toBottom();
			},
			pickFromList({ title, size, options }) {
				let settled = false;
				return new Promise<string | undefined>((resolve) => {
					dialog.replace(
						() => (
							<DialogSelect<string>
								title={title}
								placeholder="Search..."
								options={options.map((o) => ({
									title: o.title,
									value: o.value,
									description: o.description,
								}))}
								onSelect={(opt) => {
									if (settled) return;
									settled = true;
									resolve(opt.value);
								}}
							/>
						),
						// `onClose` fires when ESC dismisses the dialog
						// without a selection — resolve `undefined` so the
						// command can exit cleanly without starting a turn.
						// Also fires after `dialog.clear()` on the select
						// path (double-resolve); the `settled` flag ensures
						// only the first resolve takes effect.
						() => {
							if (settled) return;
							settled = true;
							resolve(undefined);
						},
					);
					// `dialog.replace` resets size to "medium"; set the
					// requested size after so it takes effect.
					if (size) dialog.setSize(size);
				});
			},
		};
	}

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
					const helpers = buildCommandHelpers();
					Promise.resolve(c.execute(args ?? "", helpers)).catch(
						(err: unknown) => {
							const msg = err instanceof Error ? err.message : String(err);
							toast.show({
								variant: "error",
								title: "Command error",
								message: msg,
								duration: 6000,
							});
						},
					);
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
