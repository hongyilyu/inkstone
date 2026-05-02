import {
	type AgentActions,
	createSession as createAgentSession,
	getAgentInfo,
	type Session,
	setConfirmFn,
} from "@backend/agent";
import type { AgentEvent as AgentEventType } from "@mariozechner/pi-agent-core";

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

import { setPersistenceErrorHandler } from "@backend/persistence/errors";
import {
	appendAgentMessage,
	appendDisplayMessage,
	createSession,
	finalizeDisplayMessageParts,
	loadSession,
	newId,
	runInTransaction,
	safeRun,
	type Tx,
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
import { type CommandOption, useCommand } from "../components/dialog/command";
import { DialogSelect } from "../ui/dialog-select";
import { closeSecondaryPage } from "./secondary-page";

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

/**
 * Pull a short error line out of a failed tool result. pi-agent-core
 * wraps tool execution in a try/catch and constructs an error-shaped
 * result — `content[0].text` holds the Error message. Falls through to
 * `undefined` so the renderer shows a generic error state.
 *
 * Success results are deliberately not summarized: today's tools
 * (`read`/`edit`/`write`/`update_sidebar`) all carry their user-visible
 * information in the args, so a second "result" line would just restate
 * what the header already said. If a future tool's result carries info
 * the args don't (e.g. `grep` match count), reintroduce a summary path.
 */
function extractErrorMessage(result: any): string | undefined {
	if (!result) return undefined;
	const first = Array.isArray(result.content) ? result.content[0] : undefined;
	if (first && first.type === "text" && typeof first.text === "string") {
		return trimOneLine(first.text);
	}
	return undefined;
}

function trimOneLine(s: string, limit = 120): string {
	const flat = s.replace(/\s+/g, " ").trim();
	if (flat.length <= limit) return flat;
	return `${flat.slice(0, limit - 1)}…`;
}

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
}

const ctx = createContext<AgentContextValue>();

export function AgentProvider(
	props: ParentProps<{ session?: SessionFactory }>,
) {
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
	const factory: SessionFactory = props.session ?? createAgentSession;
	const agentSession = factory({
		onEvent: (event: AgentEvent) => onAgentEvent(event),
	});

	// Mutable DB row handle. Lazily created on first user prompt to
	// avoid churning empty rows when the user boots without interacting.
	let currentSessionId: string | null = null;

	// Reasoning effort captured at the turn's user-prompt commit, used
	// at `agent_end` to stamp the turn-closing bubble. Snapshotting at
	// turn start (not reading `store.thinkingLevel` at event time)
	// insulates the historical stamp from a mid-stream model/effort
	// switch — if the user opens DialogModel + picks a new model while
	// a reply is streaming, the bubble for the in-flight turn still
	// reports the effort that actually produced it. `undefined` means
	// no turn is in flight; `"off"` means a turn started with no effort
	// and we won't persist/render a badge.
	let turnStartThinkingLevel: ThinkingLevel | undefined;

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

	/**
	 * Persist-first helper: run a tx body and apply a follow-up store
	 * mutation only if the tx succeeded. Used at reducer sites that
	 * mutate already-persisted state — inverts the old
	 * mutate-then-persist ordering so a failed write leaves the store
	 * at its pre-mutation value. The user-visible signal on failure is
	 * the toast already fired by `reportPersistenceError` inside the
	 * writer (or `runInTransaction`'s outer catch for pre-writer tx-
	 * open failures); the dedup sentinel on the error object stops the
	 * rethrow from double-toasting up the chain.
	 *
	 * Pre-stream sites (new bubble / new shell / tool-result persist /
	 * synthesized-abort persist) have no store state to gate — they
	 * use `safeRun` instead, which preserves today's "log and continue"
	 * behavior.
	 */
	function persistThen(writes: (tx: Tx) => void, onSuccess: () => void): void {
		try {
			runInTransaction(writes);
		} catch {
			// Already reported by the writer or by runInTransaction's
			// outer catch. Skip onSuccess so the store stays at its
			// pre-mutation value.
			return;
		}
		onSuccess();
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
						// `safeRun`: pre-stream append. A failed insert means
						// the shell row is missing from disk but present in the
						// store; `message_end`'s `persistThen` later uses
						// `updateDisplayMessageMeta` + `finalizeDisplayMessageParts`
						// which are UPDATE + DELETE/INSERT by `msg.id`, so the
						// UPDATE is a no-op and the INSERTs create parts with a
						// dangling FK — drizzle would fail. Acceptable because
						// the outer tx rolls back and `persistThen` skips its
						// `onSuccess`, leaving the store meta un-stamped. The
						// transient assistant bubble stays in memory for the
						// rest of the session; resume rebuilds cleanly (the
						// shell is gone, so no orphan).
						if (currentSessionId) {
							const sid = currentSessionId;
							safeRun(() =>
								runInTransaction((tx) =>
									appendDisplayMessage(tx, sid, newMsg, {
										includeParts: false,
									}),
								),
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
							// `text | thinking | file | tool` would fail
							// typecheck even though the runtime guard makes
							// it safe.
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
						case "toolcall_end": {
							// pi-ai builds the full `ToolCall` during
							// `toolcall_delta` and hands it to us on `end`
							// with `id` / `name` / `arguments`. Push a
							// `tool` display part in `"pending"` state onto
							// the assistant bubble that emitted the call —
							// same bubble pi-ai put the `toolCall` block on
							// in its `content` array. The state flips to
							// `"completed"` / `"error"` on
							// `tool_execution_end` further below.
							const tc = ame.toolCall;
							if (!tc) break;
							setStore(
								"messages",
								lastMsgIdx,
								"parts",
								produce((parts: DisplayPart[]) => {
									parts.push({
										type: "tool",
										callId: tc.id,
										name: tc.name,
										args: tc.arguments,
										state: "pending",
									});
								}),
							);
							break;
						}
						// Other `AssistantMessageEvent` variants (`start`,
						// `text_end`, `toolcall_start`, `toolcall_delta`,
						// `done`, `error`) are intentionally ignored —
						// `text_end` is a no-op for us (deltas already
						// built the part), `toolcall_start` / `_delta`
						// stream arg tokens we don't need (the full
						// `ToolCall` arrives in `toolcall_end`), and
						// stream lifecycle is handled by `message_start`
						// / `message_end` / `agent_end` on the outer
						// `AgentEvent`.
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
							// Surface assistant-turn termination onto the bubble. pi-ai
							// converts provider SDK exceptions into stream `error` events
							// (see amazon-bedrock.js:164-167) which pi-agent-core forwards
							// through message_end with `stopReason` set and `errorMessage`
							// populated. We split the two cases so the UI can render
							// differently: hard errors (`"error"`) keep the red-bordered
							// panel with the raw provider message; aborts (`"aborted"`)
							// only flip the `interrupted` flag so the footer can suffix
							// ` · interrupted` and tint the agent glyph muted — no scary
							// red panel when the user pressed ESC-ESC on purpose.
							const errorStr =
								assistantMsg.stopReason === "error" && assistantMsg.errorMessage
									? assistantMsg.errorMessage
									: undefined;
							const interruptedFlag =
								assistantMsg.stopReason === "aborted" ? true : undefined;

							// Persist-first: build the intended post-state as a
							// plain object so the tx writes the new meta WITHOUT
							// mutating the store. On success, mirror the meta
							// fields into the store. On failure, `persistThen`
							// swallows the rethrown error (already reported via
							// `reportPersistenceError`'s dedup sentinel) and the
							// store stays at its pre-mutation value — the bubble
							// renders without a footer, matching what `/resume`
							// would reconstruct.
							//
							// Parts are shallow-cloned so `updated` is fully
							// decoupled from the live Solid proxy. Matches the
							// shape at the other persistThen sites
							// (tool_execution_end, agent_end sweep) and removes
							// reliance on the implicit "reducer is synchronous"
							// invariant that kept a live-proxy splat safe.
							if (currentSessionId) {
								const sid = currentSessionId;
								const updated: DisplayMessage = {
									...last,
									parts: last.parts.map((p) => ({ ...p })),
									agentName,
									modelName: displayName,
									...(errorStr ? { error: errorStr } : {}),
									...(interruptedFlag ? { interrupted: true } : {}),
								};
								persistThen(
									(tx) => {
										updateDisplayMessageMeta(tx, sid, updated);
										finalizeDisplayMessageParts(tx, sid, updated);
										appendAgentMessage(tx, sid, msg, {
											displayMessageId: updated.id,
										});
									},
									() => {
										setStore("messages", lastIdx, "agentName", agentName);
										setStore("messages", lastIdx, "modelName", displayName);
										if (errorStr) {
											setStore("messages", lastIdx, "error", errorStr);
										}
										if (interruptedFlag) {
											setStore("messages", lastIdx, "interrupted", true);
										}
									},
								);
							}
						}
					} else if (msg && currentSessionId) {
						// Tool-result / user / custom messages — persist so the
						// raw-message timeline is complete for resume. No display
						// bubble, so `displayMessageId` stays NULL.
						//
						// `safeRun`: no store state to gate. Persistence failure
						// here is benign at runtime (pi-agent-core's in-memory
						// timeline stays valid for the active session) but causes
						// a missing tool-result row on resume — out of scope for
						// the drift fix because there's no store mirror to roll
						// back to. Fixing requires either queued retry or
						// surfacing failure into the turn-failure path; see
						// docs/TODO.md Known Issues.
						const sid = currentSessionId;
						safeRun(() =>
							runInTransaction((tx) => appendAgentMessage(tx, sid, msg)),
						);
					}
					break;
				}

				case "tool_execution_start":
					setStore("status", "tool_executing");
					break;

				case "tool_execution_end": {
					// Flip the tool part from pending → completed/error on
					// the assistant bubble that emitted this call. The
					// bubble's `message_end` already ran (pi-agent-core
					// emits that before tool execution), so its parts are
					// already committed to SQLite via
					// `finalizeDisplayMessageParts`. We update the store
					// AND re-finalize the parts so the DB matches live
					// state and survives resume.
					//
					// Also reset `status` from `"tool_executing"` back to
					// `"streaming"` — `tool_execution_start` set it, and
					// without this line it stays stuck for the remainder
					// of the turn. For non-terminating tools (`read` /
					// `edit` / `write`) the LLM will stream its follow-up
					// assistant message next; any UI gated on
					// `status === "streaming"` would read wrong otherwise.
					// `agent_end` still resets to `"idle"` at turn close.
					if (store.status === "tool_executing") {
						setStore("status", "streaming");
					}
					const endEvt = event;
					// Find the bubble + part index for this callId. Scan
					// tail-first because the matching tool part is always
					// on one of the most recent assistant bubbles (pi-
					// agent-core emits `message_end` for the assistant
					// immediately before `tool_execution_*`).
					let foundMsgIdx = -1;
					let foundPartIdx = -1;
					outer: for (let mi = store.messages.length - 1; mi >= 0; mi--) {
						const m = store.messages[mi];
						if (!m || m.role !== "assistant") continue;
						for (let pi = m.parts.length - 1; pi >= 0; pi--) {
							const p = m.parts[pi];
							if (p?.type === "tool" && p.callId === endEvt.toolCallId) {
								foundMsgIdx = mi;
								foundPartIdx = pi;
								break outer;
							}
						}
					}
					if (foundMsgIdx >= 0) {
						const state: "completed" | "error" = endEvt.isError
							? "error"
							: "completed";
						const errorMsg = endEvt.isError
							? extractErrorMessage(endEvt.result)
							: undefined;
						// Persist-first: build the post-mutation parts array
						// locally, write it to disk, then apply the single-
						// part produce mutation to the store on success. The
						// cloned `nextParts` leaves the store proxies
						// untouched — only the clone at `foundPartIdx`
						// carries the new state. On failure the bubble keeps
						// rendering `pending`, matching what `/resume` would
						// load.
						const msgAtIdx = store.messages[foundMsgIdx];
						if (currentSessionId && msgAtIdx) {
							const sid = currentSessionId;
							const nextParts = msgAtIdx.parts.map((p, i) => {
								if (i !== foundPartIdx || p.type !== "tool") return p;
								const updatedPart: DisplayPart = {
									...p,
									state,
									...(errorMsg !== undefined ? { error: errorMsg } : {}),
								};
								return updatedPart;
							});
							const updated: DisplayMessage = {
								...msgAtIdx,
								parts: nextParts,
							};
							persistThen(
								(tx) => finalizeDisplayMessageParts(tx, sid, updated),
								() => {
									setStore(
										"messages",
										foundMsgIdx,
										"parts",
										foundPartIdx,
										produce((p: DisplayPart) => {
											if (p.type !== "tool") return;
											p.state = state;
											if (errorMsg !== undefined) p.error = errorMsg;
										}),
									);
								},
							);
						}
					}

					// `update_sidebar` sidebar mutation. Independent of
					// the tool-part lookup above — the sidebar should
					// update whether or not we find the matching display
					// part (e.g. a session restored mid-turn could lack
					// the part but still want the section).
					//
					// No persist-first gating here: `sidebarSections` is
					// ephemeral store-state (cleared on `clearSession` /
					// `resumeSession`), not persisted to disk. There's
					// no disk state to keep in sync with, so the
					// persist-then-mutate invariant doesn't apply.
					if (endEvt.toolName === "update_sidebar" && endEvt.result?.details) {
						const d = endEvt.result.details as {
							operation: "upsert" | "delete";
							id: string;
							title?: string;
							content?: string;
						};
						if (d.operation === "delete") {
							setStore("sidebarSections", (sections) =>
								sections.filter((s) => s.id !== d.id),
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
					// Sweep any `pending` tool parts on assistant bubbles
					// from this session. pi-agent-core emits `agent_end`
					// for both normal completion and `handleRunFailure`
					// paths; in the failure path (user abort mid-tool,
					// provider crash in `afterToolCall`, hook exception),
					// no `tool_execution_end` fires, so the matching tool
					// part would otherwise render `~ tool …` forever —
					// live and on resume. Flip to `"error"` with a
					// generic marker. Scan all assistant bubbles because
					// a multi-tool turn can leave >1 pending (rare; safe
					// to sweep all). Persist-first: build cloned post-
					// state messages, write them atomically, then apply
					// the in-place produce walk to the store on success.
					{
						const touched: DisplayMessage[] = [];
						for (const m of store.messages) {
							if (m.role !== "assistant") continue;
							const hasPending = m.parts.some(
								(p) => p.type === "tool" && p.state === "pending",
							);
							if (!hasPending) continue;
							touched.push({
								...m,
								parts: m.parts.map((p) => {
									if (p.type !== "tool" || p.state !== "pending") return p;
									const cloned: DisplayPart = {
										...p,
										state: "error" as const,
										error: p.error ?? "Tool execution interrupted",
									};
									return cloned;
								}),
							});
						}
						if (currentSessionId && touched.length > 0) {
							const sid = currentSessionId;
							persistThen(
								(tx) => {
									for (const m of touched) {
										finalizeDisplayMessageParts(tx, sid, m);
									}
								},
								() => {
									setStore(
										"messages",
										produce((msgs: DisplayMessage[]) => {
											for (const m of msgs) {
												if (m.role !== "assistant") continue;
												for (const p of m.parts) {
													if (p.type === "tool" && p.state === "pending") {
														p.state = "error";
														if (!p.error) {
															p.error = "Tool execution interrupted";
														}
													}
												}
											}
										}),
									);
								},
							);
						}
					}
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
					//
					// `safeRun`: persistence failure here is absorbed by
					// load-time alternation repair in sessions.ts
					// (`TAIL ORPHAN` / `INTERIOR GAP` logic). Don't
					// "harden" this into `persistThen` — the repair path
					// exists precisely because this synthesized-abort
					// write can legitimately fail or be pre-empted by
					// process kill.
					{
						const endedMsgs = (event as { messages?: AgentMessage[] }).messages;
						if (endedMsgs && endedMsgs.length > 0 && currentSessionId) {
							const sid = currentSessionId;
							safeRun(() =>
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
								}),
							);
						}
					}
					// `duration` is a per-turn value. `agent_end` fires immediately after
					// the turn-closing assistant `message_end`, and tool results are not
					// rendered as display bubbles, so `messages[length - 1]` at this
					// point is guaranteed to be the turn-closing assistant bubble. That
					// bubble gets the stamp; intermediate tool-call assistant messages
					// in the same turn correctly do not. Persist-first: meta update is
					// gated on tx success — store reflects disk.
					//
					// Interrupted turns skip the duration pip — the wall-clock-
					// until-abort value would read like a completed-turn duration
					// next to the ` · interrupted` suffix, miscommunicating. Mirrors
					// OpenCode's `MessageAbortedError` branch in
					// `routes/session/index.tsx`.
					//
					// `thinkingLevel` joins `duration` as a per-turn stamp, sourced
					// from the turn-start snapshot (`turnStartThinkingLevel`) so a
					// mid-stream `setThinkingLevel` / `setModel` doesn't relabel the
					// historical bubble. `"off"` (or `undefined` when the turn didn't
					// pass through `wrappedActions.prompt`, e.g. synthetic flows) is
					// deliberately NOT persisted — the renderer hides the badge for
					// both, so NULL in the DB is lossless for display. Interrupted
					// turns also skip the thinkingLevel stamp for the same reason the
					// duration pip is skipped: the reply didn't complete, so "what
					// effort produced this turn?" has no meaningful answer.
					if (store.lastTurnStartedAt > 0) {
						const duration = Date.now() - store.lastTurnStartedAt;
						const stampedLevel =
							turnStartThinkingLevel && turnStartThinkingLevel !== "off"
								? turnStartThinkingLevel
								: undefined;
						const lastIdx = store.messages.length - 1;
						const last = store.messages[lastIdx];
						if (
							last &&
							last.role === "assistant" &&
							!last.interrupted &&
							currentSessionId
						) {
							const sid = currentSessionId;
							const updated: DisplayMessage = {
								...last,
								duration,
								...(stampedLevel ? { thinkingLevel: stampedLevel } : {}),
							};
							persistThen(
								(tx) => updateDisplayMessageMeta(tx, sid, updated),
								() => {
									setStore("messages", lastIdx, "duration", duration);
									if (stampedLevel) {
										setStore(
											"messages",
											lastIdx,
											"thinkingLevel",
											stampedLevel,
										);
									}
								},
							);
						}
					}
					// Reset the turn-scope snapshot. Next turn's prompt handler
					// re-captures; unrelated `agent_end` events (none exist in
					// the current event model, but defensive) won't inherit.
					turnStartThinkingLevel = undefined;
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
			// Persist-first: push the user bubble, stamp the turn clock,
			// and start the LLM turn only if the insert committed. On
			// failure, `reportPersistenceError` has already toasted and
			// `prompt.tsx` has already cleared the input — the user
			// retypes. Short-circuiting here keeps store/disk in sync.
			let persisted = false;
			persistThen(
				(tx) => appendDisplayMessage(tx, sessionId, userMsg),
				() => {
					persisted = true;
					setStore(
						"messages",
						produce((msgs: DisplayMessage[]) => {
							msgs.push(userMsg);
						}),
					);
					setStore("lastTurnStartedAt", Date.now());
					// Snapshot the effort at turn-start so agent_end can stamp
					// the turn-closing bubble with the value that produced it,
					// not whatever the store holds at event time.
					turnStartThinkingLevel = store.thinkingLevel;
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
							// safeRun: no store state to gate. The in-memory
							// bubble already shows the error; a persistence
							// failure here just means the error won't appear
							// on resume, which is acceptable since the agent
							// turn already failed.
							safeRun(() =>
								runInTransaction((tx) =>
									updateDisplayMessageMeta(tx, sid, updated),
								),
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
							// safeRun: synthetic bubble is best-effort. If the
							// insert fails, the in-memory view still shows the
							// error — resume will miss this particular failure
							// marker but the session timeline stays valid.
							safeRun(() =>
								runInTransaction((tx) =>
									appendDisplayMessage(tx, sid, synthetic),
								),
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
		async clearSession() {
			// Await the backend clear first. Mid-stream path: it calls
			// `agent.abort()` + `waitForIdle()` so pi-agent-core's final
			// `message_end` + `agent_end` events fire through the reducer
			// BEFORE we wipe the store here. That means the reducer's
			// `isStreaming = false` and the pending-tool-part sweep both
			// run against the still-populated store, then we clear it.
			// Swapping the order (store-wipe then await) would mean the
			// reducer's `setStore("messages", lastIdx, ...)` writes would
			// race against an empty `messages` array.
			await agentSession.clearSession();
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
				//
				// `agentSession.clearSession()` is async (see its doc),
				// but we've already guarded on `!store.isStreaming` above
				// so pi-agent-core has no `activeRun`; `waitForIdle()`
				// short-circuits and `reset()` is synchronous internally.
				// The returned Promise resolves with no side effects —
				// fire-and-forget is safe here because `batch()` can't
				// contain awaits and the idle path can't fail.
				void agentSession.clearSession();
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
				// safeRun: `displayMessage` is a command helper that pushes
				// a user-authored line into the conversation as a bubble
				// (e.g. reader's `/article` recommendation list). Failure
				// is benign at runtime — the bubble still shows in-memory;
				// resume would miss it. Matches the pre-fix behavior.
				safeRun(() =>
					runInTransaction((tx) =>
						appendDisplayMessage(tx, sessionId, userMsg),
					),
				);
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
					argGuide: c.argGuide,
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
