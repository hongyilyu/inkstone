/**
 * `MessageLog` — the one place that mutates `store.messages` AND
 * its SQLite mirror in lockstep.
 *
 * Today, seven distinct call sites in `agent/` each independently:
 *   1. clone-and-mutate a `DisplayMessage`,
 *   2. pick the right writer (`updateDisplayMessageMeta` vs
 *      `finalizeDisplayMessageParts` vs `appendDisplayMessage` vs both),
 *   3. wrap in `persistThen` so the store mutation only fires on tx
 *      success,
 *   4. tail-scan `messages` for "latest assistant" / "latest user" /
 *      "tool by callId" inline.
 *
 * That's a docstring-encoded invariant ("store and SQLite messages
 * are mirror images, with disk authoritative") plus seven
 * implementations. Adding a new persisted field touches every site
 * that writes one.
 *
 * `MessageLog` collapses those seven sites into method calls. The
 * reducer becomes a translation table from `AgentEvent` to
 * `MessageLog` calls; the seven inline `persistThen` blocks shrink
 * to one or two lines each. Tail-scan helpers live as private
 * functions next to the methods that use them — no exported
 * accessors — so callers can't accidentally route around the
 * mirror.
 *
 * Two tiers of write semantics live in this module on purpose:
 *
 *   - **persist-first** (default, all `stamp*` / `apply*` /
 *     `sweep*` / `mark*` / `appendUserBubble` / `appendAssistantShell`):
 *     run the SQLite tx body, then mutate the store only if the tx
 *     committed. Failure leaves both at their pre-mutation values.
 *
 *   - **best-effort** (`appendBubbleBestEffort`): mutate the store
 *     unconditionally; log-and-swallow the disk write. Used by
 *     `commands.displayMessage` (e.g. reader's `/article`
 *     recommendation list) where a missing-on-resume bubble is
 *     benign decoration. Matches the pre-mirror semantics.
 *
 * Both tiers are mirror-writes — they differ only on what happens
 * when the mirrors disagree. Keeping them in one module makes the
 * difference grep-able and reviewable.
 */

import {
	appendAgentMessage,
	appendDisplayMessage,
	finalizeDisplayMessageParts,
	newId,
	persist,
	type Tx,
	updateDisplayMessageMeta,
	withTransaction,
} from "@backend/persistence/sessions";
import type {
	AgentStoreState,
	DisplayMessage,
	DisplayPart,
} from "@bridge/view-model";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { produce, type SetStoreFunction } from "solid-js/store";
import { extractErrorMessage } from "./helpers";
import type { SessionState } from "./session-state";

export interface MessageLog {
	/**
	 * Persist-first push of a user bubble built from the supplied
	 * parts. Returns `true` on success, `false` if the write failed
	 * or no session exists yet — callers (today: `promptAction`) use
	 * the boolean to short-circuit downstream work like starting the
	 * LLM turn.
	 */
	appendUserBubble(parts: DisplayPart[]): boolean;

	/**
	 * `message_end` stamp: per-message error/interrupted meta on the
	 * latest assistant bubble (if any), plus the raw `AssistantMessage`
	 * appended in the same tx. The trio (meta + parts + raw) commits
	 * atomically — see ADR 0012 for why splitting into separate txs is
	 * forbidden.
	 *
	 * Per-turn meta (`agentName` / `modelName` / `duration` /
	 * `thinkingLevel`) is stamped separately at `agent_end` via
	 * `stampTurnClose` — this method only touches per-message fields.
	 *
	 * No-op if the latest message isn't an assistant bubble (e.g. a
	 * user-only timeline) — callers don't need to guard.
	 */
	stampAssistantOnMessageEnd(raw: AssistantMessage): void;

	/**
	 * `tool_execution_end` flip: find the pending tool part with the
	 * given `callId` (tail-first scan across assistant bubbles) and
	 * stamp its state to `completed` or `error`. On error, extracts a
	 * one-line error message from `result.content[0].text`.
	 *
	 * No-op if no matching tool is found — pi-agent-core may emit a
	 * stray `tool_execution_end` for a session loaded mid-turn.
	 */
	applyToolResult(callId: string, result: unknown, isError: boolean): void;

	/**
	 * `agent_end` cleanup: any tool part still in `pending` is flipped
	 * to `error` with a generic "Tool execution interrupted" marker
	 * (preserving any pre-existing per-tool error message). Covers
	 * pi-agent-core's failure paths (user abort mid-tool, provider
	 * crash in `afterToolCall`, hook exception) where no
	 * `tool_execution_end` fires for the in-flight tool.
	 *
	 * Atomic across all touched messages — a tx failure leaves both
	 * store and disk at their pre-sweep values.
	 */
	sweepPendingTools(): void;

	/**
	 * `agent_end` per-turn stamp on the latest assistant bubble.
	 * Carries `agentName` + optional `modelName` / `duration` /
	 * `thinkingLevel` (the renderer hides each field if absent).
	 *
	 * No-op if the latest message is not an assistant bubble.
	 */
	stampTurnClose(meta: TurnCloseMeta): void;

	/**
	 * `agent_end` cleanup: flag `interrupted: true` on the most recent
	 * user bubble when the turn ended without a real assistant reply.
	 * "Real" = parts present, error stamped, or already flagged
	 * interrupted. Replaces the old render-time `isDanglingUser`
	 * derivation that raced between `message_start` and the first
	 * `message_update`.
	 *
	 * No-op if there's no user bubble or its next sibling is a real
	 * reply.
	 */
	markInterruptedUser(): void;

	/**
	 * Best-effort user-bubble push: mutates the store unconditionally;
	 * a disk-write failure is logged-and-swallowed (the bubble still
	 * renders in-memory; resume would miss it, which is acceptable
	 * decoration). Used by `commands.displayMessage` for command-
	 * authored lines like reader's `/article` recommendation list.
	 *
	 * Differs from `appendUserBubble` (persist-first, gated) on
	 * purpose — see module docstring's two-tier explanation.
	 */
	appendBubbleBestEffort(parts: DisplayPart[]): void;

	/**
	 * Best-effort empty assistant shell on `message_start`. Header row
	 * inserted with no parts; parts stream in via `message_update` and
	 * are committed atomically at `message_end` via
	 * `stampAssistantOnMessageEnd`.
	 *
	 * Best-effort because a failed shell insert leaves the bubble in
	 * the store but missing from disk; `message_end`'s persist-first
	 * trio rolls back as a unit, so the in-memory bubble stays
	 * un-stamped and resume rebuilds cleanly without the orphan.
	 */
	appendAssistantShell(): void;
}

export interface TurnCloseMeta {
	agentName: string;
	modelName?: string;
	duration?: number;
	thinkingLevel?: ThinkingLevel;
}

export function createMessageLog(deps: {
	store: AgentStoreState;
	setStore: SetStoreFunction<AgentStoreState>;
	sessionState: SessionState;
}): MessageLog {
	const { store, setStore, sessionState } = deps;

	function persistThen(
		writes: (tx: Tx) => void,
		onSuccess: () => void,
	): boolean {
		try {
			withTransaction(writes);
		} catch {
			// Already reported by the writer or by withTransaction's
			// outer catch. Skip onSuccess so the store stays at its
			// pre-mutation value.
			return false;
		}
		onSuccess();
		return true;
	}

	function appendUserBubble(parts: DisplayPart[]): boolean {
		const sid = sessionState.getCurrentSessionId();
		if (!sid) return false;
		const userMsg: DisplayMessage = {
			id: newId(),
			role: "user",
			parts,
		};
		return persistThen(
			(tx) => appendDisplayMessage(tx, sid, userMsg),
			() => {
				setStore(
					"messages",
					produce((msgs: DisplayMessage[]) => {
						msgs.push(userMsg);
					}),
				);
			},
		);
	}

	function stampAssistantOnMessageEnd(raw: AssistantMessage): void {
		const sid = sessionState.getCurrentSessionId();
		if (!sid) return;
		const lastIdx = store.messages.length - 1;
		const last = store.messages[lastIdx];
		if (!last || last.role !== "assistant") return;

		// Error vs interrupted split: hard errors get the panel; aborts
		// only flip `interrupted`. Mirrors the reducer's pre-extraction
		// shape (see `stampAssistantBubbleMeta`).
		const errorStr =
			raw.stopReason === "error" && raw.errorMessage
				? raw.errorMessage
				: undefined;
		const interruptedFlag = raw.stopReason === "aborted" ? true : undefined;

		const updated: DisplayMessage = {
			...last,
			parts: last.parts.map((p) => ({ ...p })),
			...(errorStr ? { error: errorStr } : {}),
			...(interruptedFlag ? { interrupted: true } : {}),
		};

		persistThen(
			(tx) => {
				updateDisplayMessageMeta(tx, sid, updated);
				finalizeDisplayMessageParts(tx, sid, updated);
				appendAgentMessage(tx, sid, raw as AgentMessage, {
					displayMessageId: updated.id,
				});
			},
			() => {
				if (errorStr) {
					setStore("messages", lastIdx, "error", errorStr);
				}
				if (interruptedFlag) {
					setStore("messages", lastIdx, "interrupted", true);
				}
			},
		);
	}

	function findToolPart(
		callId: string,
	): { msgIdx: number; partIdx: number } | undefined {
		// Scan tail-first: the matching tool part is always on one of
		// the most recent assistant bubbles (pi-agent-core emits
		// `message_end` for the assistant immediately before
		// `tool_execution_*`).
		for (let mi = store.messages.length - 1; mi >= 0; mi--) {
			const m = store.messages[mi];
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
		callId: string,
		result: unknown,
		isError: boolean,
	): void {
		const sid = sessionState.getCurrentSessionId();
		if (!sid) return;
		const found = findToolPart(callId);
		if (!found) return;
		const msg = store.messages[found.msgIdx];
		if (!msg) return;
		const state: "completed" | "error" = isError ? "error" : "completed";
		const errorMsg = isError ? extractErrorMessage(result) : undefined;
		// Build cloned post-state parts so the store proxies stay
		// untouched until the tx commits.
		const nextParts = msg.parts.map((p, i) => {
			if (i !== found.partIdx || p.type !== "tool") return p;
			const updated: DisplayPart = {
				...p,
				state,
				...(errorMsg !== undefined ? { error: errorMsg } : {}),
			};
			return updated;
		});
		const updated: DisplayMessage = { ...msg, parts: nextParts };
		persistThen(
			(tx) => finalizeDisplayMessageParts(tx, sid, updated),
			() => {
				setStore(
					"messages",
					found.msgIdx,
					"parts",
					found.partIdx,
					produce((p: DisplayPart) => {
						if (p.type !== "tool") return;
						p.state = state;
						if (errorMsg !== undefined) p.error = errorMsg;
					}),
				);
			},
		);
	}

	function sweepPendingTools(): void {
		const sid = sessionState.getCurrentSessionId();
		if (!sid) return;
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
		if (touched.length === 0) return;
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
									if (!p.error) p.error = "Tool execution interrupted";
								}
							}
						}
					}),
				);
			},
		);
	}

	function stampTurnClose(meta: TurnCloseMeta): void {
		const sid = sessionState.getCurrentSessionId();
		if (!sid) return;
		const lastIdx = store.messages.length - 1;
		const last = store.messages[lastIdx];
		if (!last || last.role !== "assistant") return;
		const updated: DisplayMessage = {
			...last,
			agentName: meta.agentName,
			...(meta.modelName ? { modelName: meta.modelName } : {}),
			...(meta.duration !== undefined ? { duration: meta.duration } : {}),
			...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
		};
		persistThen(
			(tx) => updateDisplayMessageMeta(tx, sid, updated),
			() => {
				setStore("messages", lastIdx, "agentName", meta.agentName);
				if (meta.modelName) {
					setStore("messages", lastIdx, "modelName", meta.modelName);
				}
				if (meta.duration !== undefined) {
					setStore("messages", lastIdx, "duration", meta.duration);
				}
				if (meta.thinkingLevel) {
					setStore("messages", lastIdx, "thinkingLevel", meta.thinkingLevel);
				}
			},
		);
	}

	function markInterruptedUser(): void {
		const sid = sessionState.getCurrentSessionId();
		if (!sid) return;
		let userIdx = -1;
		for (let i = store.messages.length - 1; i >= 0; i--) {
			if (store.messages[i]?.role === "user") {
				userIdx = i;
				break;
			}
		}
		if (userIdx === -1) return;
		const next = store.messages[userIdx + 1];
		const hasRealReply =
			next &&
			next.role === "assistant" &&
			(next.parts.length > 0 || !!next.error || !!next.interrupted);
		if (hasRealReply) return;
		const userMsg = store.messages[userIdx];
		if (!userMsg) return;
		const updated: DisplayMessage = {
			...userMsg,
			parts: userMsg.parts.map((p) => ({ ...p })),
			interrupted: true,
		};
		persistThen(
			(tx) => updateDisplayMessageMeta(tx, sid, updated),
			() => {
				setStore("messages", userIdx, "interrupted", true);
			},
		);
	}

	function pushBestEffort(msg: DisplayMessage, includeParts: boolean): void {
		setStore(
			"messages",
			produce((msgs: DisplayMessage[]) => {
				msgs.push(msg);
			}),
		);
		const sid = sessionState.getCurrentSessionId();
		if (!sid) return;
		// Best-effort: store mutation already happened above; this
		// disk write is post-hoc. `persist` without `onSuccess` is the
		// log-and-continue shape — failure is reported via the toast
		// surface but doesn't propagate.
		persist((tx) => appendDisplayMessage(tx, sid, msg, { includeParts }));
	}

	function appendBubbleBestEffort(parts: DisplayPart[]): void {
		pushBestEffort({ id: newId(), role: "user", parts }, true);
	}

	function appendAssistantShell(): void {
		pushBestEffort({ id: newId(), role: "assistant", parts: [] }, false);
	}

	return {
		appendUserBubble,
		stampAssistantOnMessageEnd,
		applyToolResult,
		sweepPendingTools,
		stampTurnClose,
		markInterruptedUser,
		appendBubbleBestEffort,
		appendAssistantShell,
	};
}
