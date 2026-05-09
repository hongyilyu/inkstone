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
 * `stampTurnClosingBubble`, `stampInterruptedUser`,
 * `detectCodexTransport`) so the case body reads as a sequence of
 * intention-revealing calls instead of 260 lines of scrolling.
 */

import type { Session } from "@backend/agent";
import { getAgentInfo } from "@backend/agent";
import {
	appendAgentMessage,
	forkSession,
	persist,
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
import type { LayoutContextValue } from "../../context/layout";
import { REDACTED_THINKING_PLACEHOLDERS } from "./helpers";
import type { MessageLog } from "./message-log";
import type { SessionState } from "./session-state";

export interface ReducerDeps {
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
	sessionState: SessionState;
	agentSession: Session;
	layout: LayoutContextValue;
	/**
	 * Store-↔-disk mirror for `store.messages`. Wired through here so
	 * the migration to event-shaped methods can land call-site-by-call-
	 * site without re-threading the dep bag. See `message-log.ts` for
	 * the full surface and the two-tier (persist-first vs best-effort)
	 * invariant.
	 */
	messageLog: MessageLog;
	/**
	 * Routing seam: called from inside `handleAgentEnd`'s `setTimeout(0)`
	 * macrotask after the router's `dispatch` tool resolved and the
	 * fork was written. The provider wires this to the wrapped
	 * `resumeSession` action, which loads the freshly-forked child
	 * session and rebinds the live Agent onto its target. Forward-
	 * referenced because `wrappedActions` is constructed AFTER the
	 * reducer (which observes events on the agent loop). The macrotask
	 * defer is load-bearing: pi-agent-core's `finishRun()` clears its
	 * `activeRun` only AFTER `agent_end` listeners settle, so a
	 * microtask would still see `signal` truthy and `clearSession`
	 * would take the async-abort branch (the void caller can't await,
	 * messages stay populated, `selectAgent` throws). See
	 * `applyDispatchResult` for the full timing rationale.
	 */
	resumeSession: (sessionId: string) => void;
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
	deps.layout.scrollToBottom();
}

// ────────────────────────────────────────────────────────────────────
// message_start
// ────────────────────────────────────────────────────────────────────

function handleMessageStart(event: AgentEvent, deps: ReducerDeps): void {
	const msg = (event as any).message;
	if (!msg || msg.role !== "assistant") return;
	// Best-effort header insert — parts stream in and get flushed at
	// `message_end` via `stampAssistantOnMessageEnd`. A failed shell
	// insert leaves the bubble in the store but missing from disk;
	// `message_end`'s persist-first trio rolls back as a unit, so the
	// in-memory bubble stays un-stamped and resume rebuilds cleanly.
	deps.messageLog.appendAssistantShell();
	deps.layout.scrollToBottom();
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
	const msg = (event as any).message as AgentMessage | undefined;
	if (msg && msg.role === "assistant") {
		// Accumulate token usage and cost from assistant messages.
		// `cost?.total ?? 0` mirrors the resume-time rollup in
		// `loadSession` (`sessions.ts`) — pi-ai types `cost.total` as
		// non-optional, but defending against a provider writing `usage`
		// without a cost breakdown is cheap and keeps the two accumulators
		// in lockstep; otherwise a sparse-usage stream would crash here
		// (TypeError on `.total`) while loading the same session back
		// would silently succeed. Ungated on tx success — these are
		// running totals, recomputed from disk on resume.
		const usage = (msg as AssistantMessage).usage;
		if (usage) {
			deps.setStore("totalTokens", (t) => t + usage.totalTokens);
			deps.setStore("totalCost", (c) => c + (usage.cost?.total ?? 0));
		}
		deps.messageLog.stampAssistantOnMessageEnd(msg as AssistantMessage);
		return;
	}
	if (msg) {
		persistNonAssistantMessage(msg, deps);
	}
}

function persistNonAssistantMessage(
	msg: AgentMessage,
	deps: ReducerDeps,
): void {
	// Tool-result / user / custom messages — persist so the raw-
	// message timeline is complete for resume. No display bubble, so
	// `displayMessageId` stays NULL.
	//
	// Log-and-continue: no store state to gate. Persistence failure
	// here is benign at runtime (pi-agent-core's in-memory timeline
	// stays valid for the active session) but causes a missing tool-
	// result row on resume — out of scope for the drift fix because
	// there's no store mirror to roll back to. Fixing requires either
	// queued retry or surfacing failure into the turn-failure path;
	// see docs/TODO.md Known Issues.
	const sid = deps.sessionState.getCurrentSessionId();
	if (!sid) return;
	persist((tx) => appendAgentMessage(tx, sid, msg));
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
	deps.messageLog.applyToolResult(
		endEvt.toolCallId,
		endEvt.result,
		!!endEvt.isError,
	);
	applySidebarMutation(endEvt, deps);
	applyDispatchResult(endEvt, deps);
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

/**
 * Routing seam — the `dispatch` tool's result handler.
 *
 * Per ADR 0007 + grilling Q11 (C'.iii), when the router's `dispatch`
 * tool resolves with a chosen target agent, the TUI:
 *   1. Synchronously forks the router's session into a child bound to
 *      the target, seeding the user's first message into both the
 *      child's display + agent_messages tables.
 *   2. Stashes the child sid on `sessionState.pendingDispatchChildId`.
 *      `handleAgentEnd` reads this stash and triggers `resumeSession`
 *      from there — pi-agent-core's loop has fully unwound by the time
 *      `agent_end` fires (it's the loop's last event), so
 *      `clearSession`'s `agent.reset()` runs without racing in-flight
 *      loop state.
 *
 * Why not run the resume here directly? Because `resumeSession` calls
 * `clearSession` → `agent.reset()` which clears `agent.state.messages`.
 * If the loop is still mid-step (e.g. the assistant message that emitted
 * the dispatch hasn't finalized), the reset's effect can be undone by
 * pi-agent-core's still-running message-finalization step, leaving the
 * Agent with messages.length > 0 right when `selectAgent` (called next
 * inside the resume flow's `batch()`) checks the empty-session
 * invariant. Deferring to `agent_end` guarantees the loop is idle.
 *
 * Why not `queueMicrotask`? Because microtasks can run BEFORE the next
 * scheduled `agent_end` (they drain whenever the JS stack empties, even
 * inside pi-agent-core's promise chain). `agent_end` is the only signal
 * that says "loop is fully idle." Use it.
 *
 * Errors:
 *   - Bad/missing `target`, `parentSid`, or user message: silent skip.
 *     Misroute correction is a fresh open-page submit per Q5.
 *   - LLM-emitted dispatch failure (`isError === true`): treated as a
 *     misroute. Same silent skip; user re-submits.
 *   - `forkSession()` throws (DB write failure): caught here. Without
 *     the catch, the throw propagates through Solid `batch()` and
 *     corrupts reducer state.
 */
function applyDispatchResult(endEvt: any, deps: ReducerDeps): void {
	if (endEvt.toolName !== "dispatch") return;
	if (endEvt.isError) return;
	const target = endEvt.result?.details?.agent;
	if (typeof target !== "string" || target.length === 0) return;

	const parentSid = deps.sessionState.getCurrentSessionId();
	if (!parentSid) return;

	// The user's first message lives in store.messages — it was
	// persisted by `appendUserBubble` when the open-page submit fired.
	// Find by role so a synthetic assistant shell (appended on
	// `message_start`) doesn't get picked.
	const userDisplay = deps.store.messages.find((m) => m.role === "user");
	if (!userDisplay) return;
	// Build the LLM-facing message content from the display parts.
	// Today the open page only accepts plain-text typing (slash + Tab
	// paths bypass the router), so this is always `[{ type: "text" }]`
	// in production. The map preserves every text part and skips
	// non-text parts (file/thinking/tool/fork) — `text` is the only
	// type pi-ai's `UserMessage.content` accepts that we currently
	// produce. A future open-page enhancement (image paste, attached
	// files) should extend this map rather than continue to drop
	// silently.
	const agentContent = userDisplay.parts.flatMap((p) =>
		p.type === "text" && p.text.length > 0
			? [{ type: "text" as const, text: p.text }]
			: [],
	);
	if (agentContent.length === 0) return;

	let child: ReturnType<typeof forkSession>;
	try {
		child = forkSession({
			parentId: parentSid,
			// `currentAgent` is still the router at this point — the
			// store swap to the child agent happens later, inside
			// `resumeSession`. Capture it here so the seeded user
			// message carries the parent agent's name in its bubble
			// footer (per the routing UX: user typed this while bound
			// to the router).
			parentAgent: deps.store.currentAgent,
			targetAgent: target,
			seedMessages: [
				{
					display: userDisplay,
					agentMessage: {
						role: "user",
						content: agentContent,
						timestamp: Date.now(),
					},
				},
			],
		});
	} catch {
		// `forkSession` already reported via `reportPersistenceError`
		// and rethrew. Return here so the throw doesn't propagate
		// through Solid's `batch()` and corrupt reducer state.
		return;
	}

	// Hand off to handleAgentEnd. Until it runs, the prompt stays
	// locked (handleAgentEnd skips its `isStreaming = false` reset
	// when the stash is set, so the user can't submit on the
	// about-to-be-abandoned router session).
	deps.sessionState.setPendingDispatchChildId(child.id);
}

// ────────────────────────────────────────────────────────────────────
// agent_end — 5 independent concerns
// ────────────────────────────────────────────────────────────────────

function handleAgentEnd(event: AgentEvent, deps: ReducerDeps): void {
	// Routing-seam handoff: a `dispatch` tool result this turn stashed
	// the child session id (see `applyDispatchResult`). Skip the normal
	// turn-close concerns (`isStreaming` reset, closing-bubble stamp,
	// synthesized-abort persist, interrupted-user mark) — those operate
	// on the router session which is hidden from listSessions per
	// ADR 0007 / grilling Q16. The resume-flow's `clearSession` owns
	// the `isStreaming = false` reset for the new active session.
	//
	// Defer the resume via `setTimeout(0)` (macrotask, not microtask):
	// `agent_end` event delivery happens INSIDE pi-agent-core's
	// `processEvents` while `activeRun` is still set, so `signal`
	// (read by `clearSession`) is still truthy — `clearSession` would
	// take its async-abort branch and the `void` discards the await,
	// leaving `agent.state.messages` non-empty when `selectAgent`
	// checks the empty-session invariant inside the resume's `batch()`.
	// Pi-agent-core's `finishRun()` clears `activeRun` AFTER all
	// `agent_end` listeners settle. A microtask runs while listeners
	// are still being awaited (inside `for...of` await chain), so it's
	// too early. A macrotask runs after `finishRun()` completes —
	// `signal` is undefined, `clearSession` takes the sync branch,
	// `agent.reset()` actually clears messages.
	const pendingChildId = deps.sessionState.getPendingDispatchChildId();
	if (pendingChildId) {
		deps.sessionState.setPendingDispatchChildId(null);
		setTimeout(() => {
			// Wrap in `batch()` to coalesce store mutations across the
			// whole sequence. The macrotask runs OUTSIDE the
			// dispatcher's `batch()` (setTimeout defers past it), so
			// without this wrap the four+ `setStore` calls below
			// (status, isStreaming, plus everything `resumeSession`
			// and the interrupted-clear touch) each trigger a separate
			// Solid scheduler pass — visible flicker between
			// "isStreaming = false but parent messages still showing"
			// and "messages swapped to child". `continue()` stays
			// outside the batch — it's an async call into pi-agent-core,
			// not a store mutation.
			batch(() => {
				// Clear status fields so resumeSession's busy-guard
				// (`if (deps.store.isStreaming) return`) lets the call
				// through. We own this reset because `agent_end` skipped
				// it.
				deps.setStore("isStreaming", false);
				deps.setStore("status", "idle");
				deps.resumeSession(pendingChildId);
				// resumeSession runs `loadSession` which applies
				// `repairAlternation` — for a freshly-forked child whose
				// `agent_messages` is just `[user]`, repair appends a
				// synthesized aborted assistant to satisfy the
				// alternation invariant. That's right for resume
				// semantics, but wrong for the seam: we want to RUN the
				// child's first turn now, and pi-agent-core's
				// `continue()` rejects a transcript whose tail is
				// `assistant`. Re-seed the live Agent with just the user
				// message so `continue()` sees it as the tail and runs
				// from there. The synthesized assistant stays out of the
				// LLM-facing context (and out of disk — repair is
				// read-time only).
				const seeded = deps.store.messages.flatMap((m) => {
					// Skip the fork-marker (display-only — has no
					// agent_messages counterpart and no LLM-facing
					// shape). Skip the synthesized assistant tail.
					// Keep the seeded user message — preserve every
					// text part (multi-text user messages are rare
					// today but represent the same data the original
					// agent_message content array carried at fork
					// time).
					if (m.role === "user") {
						const content = m.parts.flatMap((p) =>
							p.type === "text" && p.text.length > 0
								? [{ type: "text" as const, text: p.text }]
								: [],
						);
						if (content.length === 0) return [];
						return [
							{
								role: "user" as const,
								content,
								timestamp: Date.now(),
							},
						];
					}
					return [];
				});
				deps.agentSession.restoreMessages(seeded);
				// Clear the `interrupted` flag that loadSession's
				// repair stamped on the seeded user message. The
				// repair logic reads "user message with no following
				// real assistant" as "this turn was interrupted" —
				// correct for resumed sessions where the user truly
				// lost their reply, wrong for a freshly-forked child
				// where the reply is about to stream in. Without this
				// clear, the user sees "[Interrupted by user]" under
				// their message right when Reader starts answering.
				deps.setStore(
					"messages",
					produce((msgs: DisplayMessage[]) => {
						for (const m of msgs) {
							if (m.role === "user" && m.interrupted) {
								m.interrupted = undefined;
							}
						}
					}),
				);
			});
			// Fire the child agent's first turn. The seeded transcript
			// ends with the user's freeform message; `continue()` runs
			// the loop from the current tail without pushing a new
			// user message. Outside the `batch()` because it's an
			// async pi-agent-core call, not a store mutation.
			deps.agentSession.actions.continue().catch((err) => {
				console.error("[routing-seam] continue() failed:", err);
			});
		}, 0);
		return;
	}

	deps.setStore("isStreaming", false);
	deps.setStore("status", "idle");
	deps.messageLog.sweepPendingTools();
	persistSynthesizedAbortMessage(event, deps);
	stampTurnClosingBubble(event, deps);
	deps.messageLog.markInterruptedUser();
	// Reset the turn-scope snapshot. Next turn's prompt handler
	// re-captures; unrelated `agent_end` events (none exist in the
	// current event model, but defensive) won't inherit.
	deps.sessionState.setTurnStartThinkingLevel(undefined);
	detectCodexTransport(deps);
	deps.sessionState.setPreTurnCodexConnections(undefined);
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
	// Log-and-continue: persistence failure here is absorbed by load-
	// time alternation repair in sessions.ts (`TAIL ORPHAN` /
	// `INTERIOR GAP` logic). Don't "harden" this into a persist-first
	// `onSuccess` — the repair path exists precisely because this
	// synthesized-abort write can legitimately fail or be pre-empted
	// by process kill.
	const endedMsgs = (event as { messages?: AgentMessage[] }).messages;
	const sid = deps.sessionState.getCurrentSessionId();
	if (!endedMsgs || endedMsgs.length === 0 || !sid) return;
	persist((tx) => {
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

function stampTurnClosingBubble(event: AgentEvent, deps: ReducerDeps): void {
	// Per-turn stamps (`agentName`, `modelName`, `duration`,
	// `thinkingLevel`). The mirror write itself is the
	// `messageLog.stampTurnClose` call below; this function still
	// computes the turn-derived values (whether the turn was
	// interrupted, the closing model name, the snapshotted thinking
	// level) because those depend on caller-only state
	// (`lastTurnStartedAt`, `turnStartThinkingLevel`,
	// `event.messages`).
	if (deps.store.lastTurnStartedAt <= 0) return;
	const last = deps.store.messages[deps.store.messages.length - 1];
	if (!last || last.role !== "assistant") return;

	const endMessages = (event as { messages?: AgentMessage[] }).messages;
	const closingAgent = endMessages?.[endMessages.length - 1];
	const closingAssistant =
		closingAgent && closingAgent.role === "assistant"
			? (closingAgent as AssistantMessage)
			: undefined;
	// Fallback: if event.messages doesn't end with an assistant
	// (e.g. a trailing toolResult from a terminated run),
	// `displayName` stays undefined and AssistantFooter hides —
	// safer than rendering a bare `▣ Reader` with no model.
	const displayName = closingAssistant
		? (getModel(closingAssistant.provider as any, closingAssistant.model as any)
				?.name ?? closingAssistant.model)
		: undefined;
	const agentName = getAgentInfo(deps.store.currentAgent).displayName;

	const interrupted =
		last.interrupted ||
		closingAssistant?.stopReason === "aborted" ||
		closingAssistant?.stopReason === "error";
	const duration = interrupted
		? undefined
		: Date.now() - deps.store.lastTurnStartedAt;
	const turnLevel = deps.sessionState.getTurnStartThinkingLevel();
	const stampedLevel =
		!interrupted && turnLevel && turnLevel !== "off" ? turnLevel : undefined;

	deps.messageLog.stampTurnClose({
		agentName,
		modelName: displayName,
		duration,
		thinkingLevel: stampedLevel,
	});
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
