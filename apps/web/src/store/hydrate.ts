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
	type Segment,
	setHydrationStatus,
} from "./chat.js";

type WireSegment = ThreadGetResult["messages"][number]["segments"][number];

/** A persisted tool call's wire status maps to a live `tool_call` segment status:
 * `error` keeps its spelling, anything else (a rehydrated call is `completed`)
 * settles to `completed`. A rehydrated call is never `running`. */
function toToolCallStatus(status: string): "completed" | "error" {
	return status === "error" ? "error" : "completed";
}

/** Map one wire `Segment` to a live store {@link Segment} (ADR-0045), preserving
 * its timeline position. A `tool_call` segment carries no id (the durable record
 * has one, but the live row keys only on render order), so synthesize a stable
 * `<messageId>:seg:<i>` id from its index, keeping React keys distinct. The wire
 * `proposal` segment becomes a positional `{kind:"proposal", runId}` marker — the
 * decided card's interactive state lives in the `proposals` map, seeded separately
 * by {@link rehydrateDecidedProposals}. */
function toSegment(
	messageId: string,
	runId: string,
	segment: WireSegment,
	index: number,
): Segment {
	switch (segment.kind) {
		case "text":
			return { kind: "text", text: segment.text };
		case "tool_call":
			return {
				kind: "tool_call",
				call: {
					id: `${messageId}:seg:${index}`,
					name: segment.name,
					status: toToolCallStatus(segment.status),
					arg: segment.arg,
				},
			};
		case "proposal":
			return { kind: "proposal", runId };
		case "reasoning":
			// The model's thinking trace (ADR-0045 amendment): the wire carries Core's
			// computed `duration_ms`; store it as `durationMs`. Excluded from concatText.
			return {
				kind: "reasoning",
				text: segment.text,
				durationMs: segment.duration_ms,
			};
	}
}

/** Map a wire `MessageView` to the live {@link Message}, narrowing role/status via
 * defensive guards. The ordered `segments[]` is consumed VERBATIM (ADR-0045): the
 * wire already carries the true `run_steps` order, so the reload renders the same
 * timeline the live stream built — no legacy bucket reconstruction. An `incomplete`
 * turn whose owning Run's `terminal_reason` is `"cancelled"` sets the store's
 * `cancelled` flag, so a Stop from a prior session rehydrates as the calm stopped
 * notice, not the failure alert (ADR-0014). See docs/design/web-store.md. */
export function toMessage(view: ThreadGetResult["messages"][number]): Message {
	const role: Message["role"] = view.role === "user" ? "user" : "assistant";
	const status: Message["status"] =
		view.status === "streaming" ||
		view.status === "completed" ||
		view.status === "incomplete"
			? view.status
			: "completed";
	// The `incomplete` guard is load-bearing: a cancelled Run's USER message also
	// carries terminal_reason "cancelled" on the wire but is status "completed" —
	// it must never be flagged.
	const cancelled =
		status === "incomplete" && view.terminal_reason === "cancelled";
	const segments: Segment[] = view.segments.map((segment, i) =>
		toSegment(view.id, view.run_id, segment, i),
	);
	return {
		id: view.id,
		role,
		status,
		run_id: view.run_id,
		segments,
		// Keep the key ABSENT (not false) otherwise — matching how applyEvent
		// leaves non-cancelled turns.
		...(cancelled ? { cancelled: true } : {}),
	};
}

/**
 * Find the decided (accepted/rejected) proposal outcome carried by `runId`'s
 * message view, if any — the durable truth `decideProposal`'s -32002 settlement
 * path reads after a `thread/get` refetch. The wire `status` is a bare string
 * (Core filters to accepted/rejected, but the type is open): any other value is
 * skipped rather than coerced, mirroring {@link rehydrateDecidedProposals}.
 * `entity_id` is omitted for a rejected Proposal or when no Entity resolves.
 */
export function decidedProposalSegment(
	views: ThreadGetResult["messages"],
	runId: string,
): { status: "accepted" | "rejected"; entity_id?: string } | undefined {
	if (runId === "") {
		return undefined;
	}
	for (const view of views) {
		if (view.run_id !== runId) {
			continue;
		}
		const proposalSegment = view.segments.find(
			(seg) => seg.kind === "proposal",
		);
		if (proposalSegment === undefined) {
			continue;
		}
		const status = proposalSegment.status;
		if (status !== "accepted" && status !== "rejected") {
			continue;
		}
		return { status, entity_id: proposalSegment.entity_id };
	}
	return undefined;
}

/**
 * Reconstruct the DECIDED Proposals carried by a thread's rehydration views
 * (ADR-0044) and merge them into the `proposals` map, so a settled `ProposalCard`
 * ("Applied.") survives reload. The decided Proposal now arrives as a `proposal`
 * SEGMENT in `view.segments` (ADR-0045 folds the former `view.proposal` field in);
 * its timeline POSITION is already carried by `toMessage`, so this only seeds the
 * interactive map state (status + mutation_kind; the payload is omitted — the
 * decided card reads neither). The segment only ever carries `accepted`/`rejected`
 * (Core filters pending/cancelled). Skip-if-present (in {@link
 * rehydrateDecidedProposal}) guarantees a live pending/deciding Proposal is never
 * clobbered, so this is safe in both the normal and became-live hydration paths.
 */
function rehydrateDecidedProposals(views: ThreadGetResult["messages"]): void {
	for (const view of views) {
		if (view.run_id === "") {
			continue;
		}
		const proposalSegment = view.segments.find(
			(seg) => seg.kind === "proposal",
		);
		if (proposalSegment === undefined) {
			continue;
		}
		// Accept ONLY the two ADR-0044 decided outcomes. `status` is a bare wire
		// string (Core filters to accepted/rejected, but the type is open): ignore
		// any unknown/future value rather than coercing it to "accepted" and
		// rendering the wrong settled card.
		const status = proposalSegment.status;
		if (status !== "accepted" && status !== "rejected") {
			continue;
		}
		const proposal: PendingProposal = {
			proposal_id: proposalSegment.proposal_id,
			run_id: view.run_id,
			mutation_kind: proposalSegment.mutation_kind,
			payload: null,
			rationale: null,
			// The Entity the accepted change created/updated (ADR-0044 amendment); the
			// decided card names + deep-links it. Omitted for a rejected Proposal.
			entity_id: proposalSegment.entity_id,
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
		// Re-read state AFTER the await: a send during the fetch window may have turned this thread live.
		if (threadBecameLive(threadId)) {
			// Keep the live turn intact; fold history in front and do NOT resubscribe a settled history run.
			prependHistory(threadId, messages);
			// Reconstruct decided Proposals (ADR-0044) AFTER the history is in the store
			// (see normal path below for why position matters).
			rehydrateDecidedProposals(result.messages);
			return "ready" as const;
		}
		loadThreadMessages(threadId, messages);
		// Reconstruct decided Proposals (ADR-0044) so the settled card ("Applied.")
		// survives reload. Runs AFTER loadThreadMessages: it attaches the `proposal`
		// SEGMENT to the run's assistant message (the segment-only bubble renders the
		// decided card ONLY from that segment, ADR-0045), and a rehydrated decided
		// proposal has no live RunRecord, so the message must already be in the store
		// for `attachProposalSegment` to locate it. Skip-if-present, so it never
		// clobbers a live pending one — safe in both this and the became-live path.
		rehydrateDecidedProposals(result.messages);
		for (const message of messages) {
			if (message.status === "streaming" && message.run_id !== "") {
				startRunStream(runtime, threadId, message.run_id);
			}
		}
		return "ready" as const;
	}).pipe(
		// Two deterministic dead-ends map to `not_found` (an honest "thread isn't
		// available" state with a Back-to-New-Chat exit, never a retry that can't
		// succeed — ADR-0061 B-additive): a genuinely missing Thread (Core `-32001`
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
