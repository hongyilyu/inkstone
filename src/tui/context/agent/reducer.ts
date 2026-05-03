/**
 * Event reducer: translates pi-agent-core `AgentEvent`s into Solid
 * store mutations. Extracted from the monolithic `agent.tsx`; the
 * outer dispatcher is a thin `batch() + switch` over event types.
 *
 * Each case handler takes a `ReducerDeps` bag instead of closing over
 * module-scope state, so the reducer file stays free of top-level
 * `let` bindings — the three session-lifetime mutable values
 * (`currentSessionId`, `turnStartThinkingLevel`,
 * `preTurnCodexConnections`) all live in `SessionState` and are
 * accessed through getter/setter pairs.
 *
 * `agent_end` has five independent concerns — each is a named helper
 * (`sweepPendingTools`, `persistSynthesizedAbortMessage`,
 * `stampTurnDurationAndThinkingLevel`, `stampInterruptedUser`,
 * `detectCodexTransport`) so the case body reads as a sequence of
 * intention-revealing calls instead of 260 lines of scrolling.
 */

import type { Session } from "@backend/agent";
import { getAgentInfo } from "@backend/agent";
import {
	appendAgentMessage,
	appendDisplayMessage,
	finalizeDisplayMessageParts,
	newId,
	runInTransaction,
	safeRun,
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
	AssistantMessageEvent,
} from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getModel } from "@mariozechner/pi-ai";
import { getOpenAICodexWebSocketDebugStats } from "@mariozechner/pi-ai/openai-codex-responses";
import { batch } from "solid-js";
import { produce, type SetStoreFunction } from "solid-js/store";
import { toBottom } from "../../app";
import { extractErrorMessage, REDACTED_THINKING_PLACEHOLDERS } from "./helpers";
import type { SessionState } from "./session-state";

export interface ReducerDeps {
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
	sessionState: SessionState;
	agentSession: Session;
}

// ────────────────────────────────────────────────────────────────────
// Dispatcher
// ────────────────────────────────────────────────────────────────────

export function createAgentEventHandler(
	deps: ReducerDeps,
): (event: AgentEvent) => void {
	return (event: AgentEvent) => {
		batch(() => {
			switch (event.type) {
				case "agent_start":
					handleAgentStart(deps);
					break;
				case "message_start":
					handleMessageStart(event, deps);
					break;
				case "message_update":
					handleMessageUpdate(event, deps);
					break;
				case "message_end":
					handleMessageEnd(event, deps);
					break;
				case "tool_execution_start":
					deps.setStore("status", "tool_executing");
					break;
				case "tool_execution_end":
					handleToolExecutionEnd(event, deps);
					break;
				case "agent_end":
					handleAgentEnd(event, deps);
					break;
				default:
					break;
			}
		});
	};
}

// ────────────────────────────────────────────────────────────────────
// agent_start
// ────────────────────────────────────────────────────────────────────

function handleAgentStart(deps: ReducerDeps): void {
	deps.setStore("isStreaming", true);
	deps.setStore("status", "streaming");
	// A fresh assistant display bubble is pushed per-boundary on
	// `message_start` so tool-driven turns with multiple assistant
	// messages keep their footer metadata separate.
	toBottom();
}

// ────────────────────────────────────────────────────────────────────
// message_start
// ────────────────────────────────────────────────────────────────────

function handleMessageStart(event: AgentEvent, deps: ReducerDeps): void {
	const msg = (event as any).message;
	if (!msg || msg.role !== "assistant") return;
	const newMsg: DisplayMessage = {
		id: newId(),
		role: "assistant",
		parts: [],
	};
	deps.setStore(
		"messages",
		produce((msgs: DisplayMessage[]) => {
			msgs.push(newMsg);
		}),
	);
	// Insert the header row only — parts stream in and get flushed as
	// a batch on `message_end` via `finalizeDisplayMessageParts`.
	// Avoids the old DELETE+re-INSERT thrash that ran on every end
	// event.
	//
	// `currentSessionId` is guaranteed non-null: this branch only
	// fires during a turn, and turns only start via
	// `wrappedActions.prompt` which called `ensureSession()`.
	//
	// `safeRun`: pre-stream append. A failed insert means the shell
	// row is missing from disk but present in the store; `message_end`'s
	// `persistThen` later uses `updateDisplayMessageMeta` +
	// `finalizeDisplayMessageParts` which are UPDATE + DELETE/INSERT
	// by `msg.id`, so the UPDATE is a no-op and the INSERTs create
	// parts with a dangling FK — drizzle would fail. Acceptable
	// because the outer tx rolls back and `persistThen` skips its
	// `onSuccess`, leaving the store meta un-stamped. The transient
	// assistant bubble stays in memory for the rest of the session;
	// resume rebuilds cleanly (the shell is gone, so no orphan).
	const sid = deps.sessionState.getCurrentSessionId();
	if (sid) {
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

// ────────────────────────────────────────────────────────────────────
// message_update (inner switch on AssistantMessageEvent.type)
// ────────────────────────────────────────────────────────────────────

function handleMessageUpdate(event: AgentEvent, deps: ReducerDeps): void {
	// pi-ai's `AssistantMessageEvent` union fires `text_start` /
	// `thinking_start` deterministically before the first matching
	// delta (see pi-agent-core `agent-loop.js:175-190`). We still
	// runtime-guard the tail-part type in each delta arm — cheap
	// insurance against future upstream reordering, and it's the
	// single failure mode that would silently cross-append text into
	// a thinking block (or vice versa).
	if (!("assistantMessageEvent" in event)) return;
	const ame = (event as { assistantMessageEvent?: AssistantMessageEvent })
		.assistantMessageEvent;
	if (!ame) return;
	const lastMsgIdx = deps.store.messages.length - 1;
	if (lastMsgIdx < 0) return;

	switch (ame.type) {
		case "text_start":
			pushEmptyPart(deps, lastMsgIdx, { type: "text", text: "" });
			break;
		case "thinking_start":
			pushEmptyPart(deps, lastMsgIdx, { type: "thinking", text: "" });
			break;
		case "text_delta":
		case "thinking_delta":
			appendStreamingDelta(ame, deps, lastMsgIdx);
			break;
		case "thinking_end":
			finalizeThinkingPart(deps, lastMsgIdx);
			break;
		case "toolcall_end":
			appendToolCallPart(ame, deps, lastMsgIdx);
			break;
		// Other `AssistantMessageEvent` variants (`start`,
		// `text_end`, `toolcall_start`, `toolcall_delta`, `done`,
		// `error`) are intentionally ignored — `text_end` is a
		// no-op for us (deltas already built the part),
		// `toolcall_start` / `_delta` stream arg tokens we don't
		// need (the full `ToolCall` arrives in `toolcall_end`), and
		// stream lifecycle is handled by `message_start` /
		// `message_end` / `agent_end` on the outer `AgentEvent`.
		default:
			break;
	}
}

function pushEmptyPart(
	deps: ReducerDeps,
	msgIdx: number,
	part: DisplayPart,
): void {
	deps.setStore(
		"messages",
		msgIdx,
		"parts",
		produce((parts: DisplayPart[]) => {
			parts.push(part);
		}),
	);
}

function appendStreamingDelta(
	ame: AssistantMessageEvent & { type: "text_delta" | "thinking_delta" },
	deps: ReducerDeps,
	lastMsgIdx: number,
): void {
	if (!ame.delta) return;
	const lastMsg = deps.store.messages[lastMsgIdx];
	if (!lastMsg) return;
	const lastPartIdx = lastMsg.parts.length - 1;
	const lastPart = lastMsg.parts[lastPartIdx];
	if (!lastPart) return;
	const expected = ame.type === "text_delta" ? "text" : "thinking";
	if (lastPart.type !== expected) return;
	// Narrow through `produce` because Solid's store path typing
	// can't see the runtime `lastPart.type` guard above — addressing
	// `"text"` on the union `text | thinking | file | tool` would
	// fail typecheck even though the runtime guard makes it safe.
	deps.setStore(
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
}

function finalizeThinkingPart(deps: ReducerDeps, lastMsgIdx: number): void {
	// Drop the part if nothing renderable accumulated. Several
	// redacted-thinking shapes land here:
	//   - Anthropic `redacted: true` — pi-ai emits no `thinking_delta`
	//     at all, so `text` is "".
	//   - OpenRouter's `[REDACTED]` literal — arrives as a delta chunk
	//     and would otherwise render verbatim (`"[REDACTED]".trim()`
	//     is truthy).
	//   - pi-kiro's `Reasoning hidden by provider` — slow-path marker
	//     per conformance §26a; same shape as above.
	// Strip all known placeholders before the trim so every case
	// collapses to empty and gets popped.
	const lastMsg = deps.store.messages[lastMsgIdx];
	if (!lastMsg) return;
	const lastPartIdx = lastMsg.parts.length - 1;
	const lastPart = lastMsg.parts[lastPartIdx];
	if (!lastPart || lastPart.type !== "thinking") return;
	const stripped = REDACTED_THINKING_PLACEHOLDERS.reduce(
		(s, p) => s.replace(p, ""),
		lastPart.text,
	);
	if (stripped.trim()) return;
	deps.setStore(
		"messages",
		lastMsgIdx,
		"parts",
		produce((p: DisplayPart[]) => {
			p.pop();
		}),
	);
}

function appendToolCallPart(
	ame: AssistantMessageEvent & { type: "toolcall_end" },
	deps: ReducerDeps,
	lastMsgIdx: number,
): void {
	// pi-ai builds the full `ToolCall` during `toolcall_delta` and
	// hands it to us on `end` with `id` / `name` / `arguments`. Push
	// a `tool` display part in `"pending"` state onto the assistant
	// bubble that emitted the call — same bubble pi-ai put the
	// `toolCall` block on in its `content` array. The state flips to
	// `"completed"` / `"error"` on `tool_execution_end` further below.
	const tc = ame.toolCall;
	if (!tc) return;
	deps.setStore(
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
}

// ────────────────────────────────────────────────────────────────────
// message_end
// ────────────────────────────────────────────────────────────────────

function handleMessageEnd(event: AgentEvent, deps: ReducerDeps): void {
	// Accumulate token usage and cost from assistant messages.
	// `cost?.total ?? 0` mirrors the resume-time rollup in
	// `loadSession` (`sessions.ts`) — pi-ai types `cost.total` as
	// non-optional, but defending against a provider writing `usage`
	// without a cost breakdown is cheap and keeps the two accumulators
	// in lockstep; otherwise a sparse-usage stream would crash here
	// (TypeError on `.total`) while loading the same session back
	// would silently succeed.
	const msg = (event as any).message as AgentMessage | undefined;
	if (msg && msg.role === "assistant") {
		stampAssistantBubbleMeta(msg as AssistantMessage, deps);
		return;
	}
	if (msg) {
		persistNonAssistantMessage(msg, deps);
	}
}

function stampAssistantBubbleMeta(
	assistantMsg: AssistantMessage,
	deps: ReducerDeps,
): void {
	const usage = assistantMsg.usage;
	if (usage) {
		deps.setStore("totalTokens", (t) => t + usage.totalTokens);
		deps.setStore("totalCost", (c) => c + (usage.cost?.total ?? 0));
	}
	// Snapshot agent + model onto the assistant bubble that was
	// pushed in the matching `message_start`. Sourcing provider/model
	// from the event (not `store.modelName`) means mid-run Ctrl+P
	// model switches don't relabel an already-generated reply, and
	// tool-driven turns with multiple assistant messages get their
	// own correct per-bubble footer.
	const lastIdx = deps.store.messages.length - 1;
	const last = deps.store.messages[lastIdx];
	if (!last || last.role !== "assistant") return;
	const provider = assistantMsg.provider;
	const modelId = assistantMsg.model;
	const displayName =
		getModel(provider as any, modelId as any)?.name ?? modelId;
	// Switching agents is locked to the empty-session open page, so
	// `store.currentAgent` at event time is guaranteed to be the
	// agent that produced this reply.
	const agentName = getAgentInfo(deps.store.currentAgent).displayName;
	// Surface assistant-turn termination onto the bubble. pi-ai
	// converts provider SDK exceptions into stream `error` events
	// (see e.g. `openai-codex-responses.js`) which pi-agent-core
	// forwards through message_end with `stopReason` set and
	// `errorMessage` populated. We split the two cases so the UI
	// can render differently: hard errors (`"error"`) keep the red-
	// bordered panel with the raw provider message; aborts
	// (`"aborted"`) only flip the `interrupted` flag so the footer
	// can suffix ` · interrupted` and tint the agent glyph muted —
	// no scary red panel when the user pressed ESC-ESC on purpose.
	const errorStr =
		assistantMsg.stopReason === "error" && assistantMsg.errorMessage
			? assistantMsg.errorMessage
			: undefined;
	const interruptedFlag =
		assistantMsg.stopReason === "aborted" ? true : undefined;

	const sid = deps.sessionState.getCurrentSessionId();
	if (!sid) return;

	// Persist-first: build the intended post-state as a plain object
	// so the tx writes the new meta WITHOUT mutating the store. On
	// success, mirror the meta fields into the store. On failure,
	// `persistThen` swallows the rethrown error (already reported via
	// `reportPersistenceError`'s dedup sentinel) and the store stays
	// at its pre-mutation value — the bubble renders without a footer,
	// matching what `/resume` would reconstruct.
	//
	// Parts are shallow-cloned so `updated` is fully decoupled from
	// the live Solid proxy. Matches the shape at the other persistThen
	// sites (tool_execution_end, agent_end sweep) and removes reliance
	// on the implicit "reducer is synchronous" invariant that kept a
	// live-proxy splat safe.
	const updated: DisplayMessage = {
		...last,
		parts: last.parts.map((p) => ({ ...p })),
		agentName,
		modelName: displayName,
		...(errorStr ? { error: errorStr } : {}),
		...(interruptedFlag ? { interrupted: true } : {}),
	};
	deps.sessionState.persistThen(
		(tx) => {
			updateDisplayMessageMeta(tx, sid, updated);
			finalizeDisplayMessageParts(tx, sid, updated);
			appendAgentMessage(tx, sid, assistantMsg as AgentMessage, {
				displayMessageId: updated.id,
			});
		},
		() => {
			deps.setStore("messages", lastIdx, "agentName", agentName);
			deps.setStore("messages", lastIdx, "modelName", displayName);
			if (errorStr) {
				deps.setStore("messages", lastIdx, "error", errorStr);
			}
			if (interruptedFlag) {
				deps.setStore("messages", lastIdx, "interrupted", true);
			}
		},
	);
}

function persistNonAssistantMessage(
	msg: AgentMessage,
	deps: ReducerDeps,
): void {
	// Tool-result / user / custom messages — persist so the raw-
	// message timeline is complete for resume. No display bubble, so
	// `displayMessageId` stays NULL.
	//
	// `safeRun`: no store state to gate. Persistence failure here is
	// benign at runtime (pi-agent-core's in-memory timeline stays
	// valid for the active session) but causes a missing tool-result
	// row on resume — out of scope for the drift fix because there's
	// no store mirror to roll back to. Fixing requires either queued
	// retry or surfacing failure into the turn-failure path; see
	// docs/TODO.md Known Issues.
	const sid = deps.sessionState.getCurrentSessionId();
	if (!sid) return;
	safeRun(() => runInTransaction((tx) => appendAgentMessage(tx, sid, msg)));
}

// ────────────────────────────────────────────────────────────────────
// tool_execution_end
// ────────────────────────────────────────────────────────────────────

function handleToolExecutionEnd(event: AgentEvent, deps: ReducerDeps): void {
	// Reset `status` from `"tool_executing"` back to `"streaming"` —
	// `tool_execution_start` set it, and without this line it stays
	// stuck for the remainder of the turn. For non-terminating tools
	// (`read` / `edit` / `write`) the LLM will stream its follow-up
	// assistant message next; any UI gated on `status === "streaming"`
	// would read wrong otherwise. `agent_end` still resets to
	// `"idle"` at turn close.
	if (deps.store.status === "tool_executing") {
		deps.setStore("status", "streaming");
	}
	const endEvt = event as any;
	const found = findToolPart(deps.store.messages, endEvt.toolCallId);
	if (found) {
		applyToolResult(found.msgIdx, found.partIdx, endEvt, deps);
	}
	applySidebarMutation(endEvt, deps);
}

function findToolPart(
	messages: AgentStoreState["messages"],
	callId: string,
): { msgIdx: number; partIdx: number } | undefined {
	// Scan tail-first because the matching tool part is always on
	// one of the most recent assistant bubbles (pi-agent-core emits
	// `message_end` for the assistant immediately before
	// `tool_execution_*`).
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi];
		if (!m || m.role !== "assistant") continue;
		for (let pi = m.parts.length - 1; pi >= 0; pi--) {
			const p = m.parts[pi];
			if (p?.type === "tool" && p.callId === callId) {
				return { msgIdx: mi, partIdx: pi };
			}
		}
	}
	return undefined;
}

function applyToolResult(
	foundMsgIdx: number,
	foundPartIdx: number,
	endEvt: any,
	deps: ReducerDeps,
): void {
	const state: "completed" | "error" = endEvt.isError ? "error" : "completed";
	const errorMsg = endEvt.isError
		? extractErrorMessage(endEvt.result)
		: undefined;
	// Persist-first: build the post-mutation parts array locally,
	// write it to disk, then apply the single-part produce mutation
	// to the store on success. The cloned `nextParts` leaves the
	// store proxies untouched — only the clone at `foundPartIdx`
	// carries the new state. On failure the bubble keeps rendering
	// `pending`, matching what `/resume` would load.
	const msgAtIdx = deps.store.messages[foundMsgIdx];
	const sid = deps.sessionState.getCurrentSessionId();
	if (!sid || !msgAtIdx) return;
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
	deps.sessionState.persistThen(
		(tx) => finalizeDisplayMessageParts(tx, sid, updated),
		() => {
			deps.setStore(
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

function applySidebarMutation(endEvt: any, deps: ReducerDeps): void {
	// `update_sidebar` sidebar mutation. Independent of the tool-part
	// lookup above — the sidebar should update whether or not we find
	// the matching display part (e.g. a session restored mid-turn
	// could lack the part but still want the section).
	//
	// No persist-first gating here: `sidebarSections` is ephemeral
	// store-state (cleared on `clearSession` / `resumeSession`), not
	// persisted to disk. There's no disk state to keep in sync with,
	// so the persist-then-mutate invariant doesn't apply.
	if (endEvt.toolName !== "update_sidebar" || !endEvt.result?.details) return;
	const d = endEvt.result.details as {
		operation: "upsert" | "delete";
		id: string;
		title?: string;
		content?: string;
	};
	if (d.operation === "delete") {
		deps.setStore("sidebarSections", (sections) =>
			sections.filter((s) => s.id !== d.id),
		);
		return;
	}
	if (d.operation === "upsert" && d.title && d.content) {
		const title = d.title;
		const content = d.content;
		deps.setStore(
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

// ────────────────────────────────────────────────────────────────────
// agent_end — 5 independent concerns
// ────────────────────────────────────────────────────────────────────

function handleAgentEnd(event: AgentEvent, deps: ReducerDeps): void {
	deps.setStore("isStreaming", false);
	deps.setStore("status", "idle");
	sweepPendingTools(deps);
	persistSynthesizedAbortMessage(event, deps);
	stampTurnDurationAndThinkingLevel(deps);
	stampInterruptedUser(deps);
	// Reset the turn-scope snapshot. Next turn's prompt handler
	// re-captures; unrelated `agent_end` events (none exist in the
	// current event model, but defensive) won't inherit.
	deps.sessionState.setTurnStartThinkingLevel(undefined);
	detectCodexTransport(deps);
	deps.sessionState.setPreTurnCodexConnections(undefined);
}

function sweepPendingTools(deps: ReducerDeps): void {
	// Sweep any `pending` tool parts on assistant bubbles from this
	// session. pi-agent-core emits `agent_end` for both normal
	// completion and `handleRunFailure` paths; in the failure path
	// (user abort mid-tool, provider crash in `afterToolCall`, hook
	// exception), no `tool_execution_end` fires, so the matching
	// tool part would otherwise render `~ tool …` forever — live
	// and on resume. Flip to `"error"` with a generic marker. Scan
	// all assistant bubbles because a multi-tool turn can leave >1
	// pending (rare; safe to sweep all). Persist-first: build cloned
	// post-state messages, write them atomically, then apply the in-
	// place produce walk to the store on success.
	const touched: DisplayMessage[] = [];
	for (const m of deps.store.messages) {
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
	const sid = deps.sessionState.getCurrentSessionId();
	if (!sid || touched.length === 0) return;
	deps.sessionState.persistThen(
		(tx) => {
			for (const m of touched) {
				finalizeDisplayMessageParts(tx, sid, m);
			}
		},
		() => {
			deps.setStore(
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

function persistSynthesizedAbortMessage(
	event: AgentEvent,
	deps: ReducerDeps,
): void {
	// Persist any closing assistant AgentMessage that
	// `handleRunFailure` synthesized on abort/error. pi-agent-core's
	// `handleRunFailure` pushes a synthetic `{ role: "assistant",
	// stopReason: "aborted"|"error" }` into `_state.messages` and
	// emits **only** `agent_end` — no `message_end` — so our normal
	// persistence path (which writes to `agent_messages` inside
	// `message_end`) misses it. Without this catch-up write, the
	// next prompt on this session hands the provider
	// `[..., user, user]`: Anthropic silently merges consecutive
	// user turns; Bedrock 400s. `agent_end` carries the synthesized
	// message(s) in its `messages` array — see `handleRunFailure`
	// in pi-agent-core `agent.js:326-341`. We append any message
	// from that array that wasn't already persisted via the normal
	// `message_end` path.
	//
	// `safeRun`: persistence failure here is absorbed by load-time
	// alternation repair in sessions.ts (`TAIL ORPHAN` / `INTERIOR
	// GAP` logic). Don't "harden" this into `persistThen` — the
	// repair path exists precisely because this synthesized-abort
	// write can legitimately fail or be pre-empted by process kill.
	const endedMsgs = (event as { messages?: AgentMessage[] }).messages;
	const sid = deps.sessionState.getCurrentSessionId();
	if (!endedMsgs || endedMsgs.length === 0 || !sid) return;
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

function stampTurnDurationAndThinkingLevel(deps: ReducerDeps): void {
	// `duration` is a per-turn value. `agent_end` fires immediately
	// after the turn-closing assistant `message_end`, and tool
	// results are not rendered as display bubbles, so
	// `messages[length - 1]` at this point is guaranteed to be the
	// turn-closing assistant bubble. That bubble gets the stamp;
	// intermediate tool-call assistant messages in the same turn
	// correctly do not. Persist-first: meta update is gated on tx
	// success — store reflects disk.
	//
	// Interrupted turns skip the duration pip — the wall-clock-
	// until-abort value would read like a completed-turn duration
	// next to the ` · interrupted` suffix, miscommunicating.
	// Mirrors OpenCode's `MessageAbortedError` branch in
	// `routes/session/index.tsx`.
	//
	// `thinkingLevel` joins `duration` as a per-turn stamp, sourced
	// from the turn-start snapshot (`turnStartThinkingLevel`) so a
	// mid-stream `setThinkingLevel` / `setModel` doesn't relabel
	// the historical bubble. `"off"` (or `undefined` when the turn
	// didn't pass through `wrappedActions.prompt`, e.g. synthetic
	// flows) is deliberately NOT persisted — the renderer hides
	// the badge for both, so NULL in the DB is lossless for display.
	// Interrupted turns also skip the thinkingLevel stamp for the
	// same reason the duration pip is skipped: the reply didn't
	// complete, so "what effort produced this turn?" has no
	// meaningful answer.
	if (deps.store.lastTurnStartedAt <= 0) return;
	const duration = Date.now() - deps.store.lastTurnStartedAt;
	const turnLevel = deps.sessionState.getTurnStartThinkingLevel();
	const stampedLevel = turnLevel && turnLevel !== "off" ? turnLevel : undefined;
	const lastIdx = deps.store.messages.length - 1;
	const last = deps.store.messages[lastIdx];
	const sid = deps.sessionState.getCurrentSessionId();
	if (!last || last.role !== "assistant" || last.interrupted || !sid) return;
	const updated: DisplayMessage = {
		...last,
		duration,
		...(stampedLevel ? { thinkingLevel: stampedLevel } : {}),
	};
	deps.sessionState.persistThen(
		(tx) => updateDisplayMessageMeta(tx, sid, updated),
		() => {
			deps.setStore("messages", lastIdx, "duration", duration);
			if (stampedLevel) {
				deps.setStore("messages", lastIdx, "thinkingLevel", stampedLevel);
			}
		},
	);
}

function stampInterruptedUser(deps: ReducerDeps): void {
	// Stamp `interrupted` on the user bubble when the turn ended
	// without a real assistant reply. "Real" = at least one part, or
	// an error, or the assistant itself already flagged interrupted.
	// This replaces the old render-time `isDanglingUser` derivation
	// that raced between `message_start` (empty shell pushed) and
	// the first `message_update` (parts arrive), causing a flash of
	// `[Interrupted by user]` on fast models (GPT 5.5 no-effort).
	// Stamping here — at `agent_end`, the authoritative "stream is
	// over" boundary — eliminates the race: the flag is never set
	// during normal streaming.
	let userIdx = -1;
	for (let i = deps.store.messages.length - 1; i >= 0; i--) {
		if (deps.store.messages[i]?.role === "user") {
			userIdx = i;
			break;
		}
	}
	if (userIdx === -1) return;
	const next = deps.store.messages[userIdx + 1];
	const hasRealReply =
		next &&
		next.role === "assistant" &&
		(next.parts.length > 0 || !!next.error || !!next.interrupted);
	if (hasRealReply) return;
	const sid = deps.sessionState.getCurrentSessionId();
	const userMsg = deps.store.messages[userIdx];
	if (!sid || !userMsg) return;
	const updated: DisplayMessage = {
		...userMsg,
		parts: userMsg.parts.map((p) => ({ ...p })),
		interrupted: true,
	};
	deps.sessionState.persistThen(
		(tx) => updateDisplayMessageMeta(tx, sid, updated),
		() => {
			deps.setStore("messages", userIdx, "interrupted", true);
		},
	);
}

function detectCodexTransport(deps: ReducerDeps): void {
	// Codex transport detection — decide whether this turn ran on
	// WebSocket (pi-ai's `"auto"` transport happy path;
	// `websocket-cached` continuation active for subsequent turns)
	// or fell back to SSE. Signal: pi-ai's WebSocket debug counter
	// (`connectionsCreated + connectionsReused`) advances only when
	// `processWebSocketStream` reaches the body-request step
	// (`openai-codex-responses.js:768-774`). If `"auto"` aborted
	// the WebSocket path before that point, the counter stays at
	// the pre-turn snapshot — that's the SSE-fallback signal. The
	// outcome lands on `store.codexTransport` (`"ws"` / `"sse"`)
	// and is rendered as a muted suffix on the prompt statusline
	// next to the model name. Ephemeral — never persisted to
	// SQLite or stamped onto `DisplayMessage`: transport is a
	// network-state signal, not a historical property of a specific
	// turn. The next Codex turn overwrites this field so the
	// indicator always reflects the most recent real attempt.
	// `/clear` and `resumeSession` reset it (same lifecycle as
	// `sidebarSections`). No update when Codex isn't the active
	// provider (`preTurnCodexConnections` undefined) — the previous
	// value stays on screen until the user sends another Codex turn
	// or clears.
	const preTurn = deps.sessionState.getPreTurnCodexConnections();
	const sid = deps.sessionState.getCurrentSessionId();
	if (
		preTurn === undefined ||
		!sid ||
		deps.store.modelProvider !== "openai-codex"
	) {
		return;
	}
	const post = getOpenAICodexWebSocketDebugStats(sid);
	const postTotal =
		(post?.connectionsCreated ?? 0) + (post?.connectionsReused ?? 0);
	deps.setStore("codexTransport", postTotal === preTurn ? "sse" : "ws");
}
