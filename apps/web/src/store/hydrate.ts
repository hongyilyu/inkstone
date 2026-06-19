import type { ThreadGetResult } from "@inkstone/protocol";
import {
	type InvalidParamsError,
	type UnknownThreadError,
	WsClient,
} from "@inkstone/ui-sdk";
import { Effect } from "effect";
import { useEffect } from "react";
import type { WsRuntime } from "../runtime.js";
import { startRunStream } from "./bridge.js";
import {
	getChatState,
	getHydrationStatus,
	loadThreadMessages,
	type Message,
	type PendingProposal,
	prependHistory,
	rehydrateDecidedProposal,
	setHydrationStatus,
	type ToolCall,
} from "./chat.js";

/** A persisted tool call's wire status maps to a live {@link ToolCall} status:
 * `error` keeps its spelling, anything else (a rehydrated call is `completed`)
 * settles to `completed`. A rehydrated call is never `running`. */
function toToolCallStatus(status: string): ToolCall["status"] {
	return status === "error" ? "error" : "completed";
}

/** Map a wire `MessageView` to the live {@link Message}, narrowing role/status via defensive guards — see docs/design/web-store.md. */
export function toMessage(view: ThreadGetResult["messages"][number]): Message {
	const role: Message["role"] = view.role === "user" ? "user" : "assistant";
	const status: Message["status"] =
		view.status === "streaming" ||
		view.status === "completed" ||
		view.status === "incomplete"
			? view.status
			: "completed";
	// Rehydrate tool-activity rows (ADR-0043). `MessageView.tool_calls` carries
	// no id (the durable record has one, but the live row keys only on render
	// order); synthesize a stable per-index id so React keys stay distinct.
	const toolCalls: ToolCall[] = view.tool_calls.map((tc, i) => ({
		id: `${view.id}:tc:${i}`,
		name: tc.name,
		status: toToolCallStatus(tc.status),
		arg: tc.arg,
	}));
	return {
		id: view.id,
		role,
		status,
		text: view.text,
		run_id: view.run_id,
		toolCalls,
	};
}

/**
 * Reconstruct the DECIDED Proposals carried by a thread's rehydration views
 * (ADR-0044) and merge them into the store, so a settled `ProposalCard` ("Applied.")
 * survives reload. The wire `MessageView.proposal` only ever carries `accepted`/
 * `rejected` (Core filters pending/cancelled), and the reconstructed record omits
 * the payload — the decided card reads only `status` + `mutation_kind`. Skip-if-present
 * (in {@link rehydrateDecidedProposal}) guarantees a live pending/deciding Proposal is
 * never clobbered, so this is safe in both the normal and became-live hydration paths.
 */
function rehydrateDecidedProposals(views: ThreadGetResult["messages"]): void {
	for (const view of views) {
		if (view.proposal === undefined || view.run_id === "") {
			continue;
		}
		// Accept ONLY the two ADR-0044 decided outcomes. `status` is a bare wire
		// string (Core filters to accepted/rejected, but the type is open): ignore
		// any unknown/future value rather than coercing it to "accepted" and
		// rendering the wrong settled card.
		const status = view.proposal.status;
		if (status !== "accepted" && status !== "rejected") {
			continue;
		}
		const proposal: PendingProposal = {
			proposal_id: view.proposal.proposal_id,
			run_id: view.run_id,
			mutation_kind: view.proposal.mutation_kind,
			payload: null,
			rationale: null,
			status,
		};
		rehydrateDecidedProposal(proposal);
	}
}

/** True when a send during the fetch window turned this thread live (a live turn we must not clobber or flag as failed). */
function threadBecameLive(threadId: string): boolean {
	const live = getChatState().threads[threadId];
	return live?.activeRunId !== undefined || (live?.messages.length ?? 0) > 0;
}

/**
 * Hydrate a thread from `thread/get` and resume any streaming run (slice 13).
 * Drives the reactive hydration status (issue #108): `loading` before the fetch,
 * then `ready` on success or `error` on a failed fetch so {@link ChatColumn} can
 * show a recoverable error instead of an eternal skeleton. The returned Promise
 * always resolves (a failed fetch is surfaced via status, not a throw).
 * Became-live handling (send during the fetch window) folds history in non-destructively
 * via {@link prependHistory} instead of replacing — see docs/design/web-store.md.
 */
export function hydrateThread(
	runtime: WsRuntime,
	threadId: string,
): Promise<void> {
	setHydrationStatus(threadId, "loading");
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		const result = yield* client.threadGet(threadId);
		const messages = result.messages.map(toMessage);
		// Reconstruct decided Proposals (ADR-0044) so the settled card ("Applied.")
		// survives reload. Skip-if-present, so it never clobbers a live pending one
		// — safe in both the became-live and normal paths below.
		rehydrateDecidedProposals(result.messages);
		// Re-read state AFTER the await: a send during the fetch window may have turned this thread live.
		if (threadBecameLive(threadId)) {
			// Keep the live turn intact; fold history in front and do NOT resubscribe a settled history run.
			prependHistory(threadId, messages);
			return "ready" as const;
		}
		loadThreadMessages(threadId, messages);
		for (const message of messages) {
			if (message.status === "streaming" && message.run_id !== "") {
				startRunStream(runtime, threadId, message.run_id);
			}
		}
		return "ready" as const;
	}).pipe(
		// Two deterministic dead-ends map to `not_found` (an honest "thread isn't
		// available" state with a Back-to-New-Chat exit, never a retry that can't
		// succeed — ADR-0042 B-additive): a genuinely missing Thread (Core `-32001`
		// → UnknownThreadError) and a malformed thread id (Core `-32602` →
		// InvalidParamsError, e.g. a typo'd or truncated shared `/thread/<bad>` link —
		// the id is arbitrary URL input the route does not pre-validate). Both fail
		// identically on every retry, so neither belongs on the recoverable `error`
		// path. A transient WsRequestError falls through to the rejection branch and
		// keeps the existing retry affordance.
		Effect.catchTag("UnknownThreadError", (_e: UnknownThreadError) =>
			Effect.succeed("not_found" as const),
		),
		Effect.catchTag("InvalidParamsError", (_e: InvalidParamsError) =>
			Effect.succeed("not_found" as const),
		),
	);
	return runtime.runPromise(program).then(
		(status) => {
			// A send during the fetch window can turn a "missing" Thread live (the
			// optimistic seed): keep that live turn rather than blanking it to not-found.
			if (status === "not_found" && threadBecameLive(threadId)) {
				setHydrationStatus(threadId, "ready");
				return;
			}
			setHydrationStatus(threadId, status);
		},
		() => {
			// Failed thread/get (transient): if a send made the thread live mid-fetch, keep that live turn (ready);
			// otherwise surface a recoverable error rather than spinning the skeleton forever.
			setHydrationStatus(
				threadId,
				threadBecameLive(threadId) ? "ready" : "error",
			);
		},
	);
}

/** Hydrate the focused thread on focus change when it is non-null and has never hydrated (slice 13). A failed hydration is retried only by the user (error affordance), never auto-looped. */
export function useHydrateFocusedThread(
	runtime: WsRuntime,
	focusedThreadId: string | null,
): void {
	useEffect(() => {
		if (
			focusedThreadId !== null &&
			getHydrationStatus(focusedThreadId) === undefined
		) {
			void hydrateThread(runtime, focusedThreadId);
		}
	}, [runtime, focusedThreadId]);
}
