import type {
	ProposalDecideParams,
	ProposalDecideResult,
	ProposalGetResult,
	ThreadGetResult,
} from "@inkstone/protocol";
import type {
	ProposalNotification,
	RunEventValue,
	RunId,
	WsError,
} from "@inkstone/ui-sdk";
import { makeCoreRuntime } from "@test/test-utils/renderWithCore";
import { Effect, type Queue, Stream } from "effect";

export const JOURNAL_ENTRY = {
	occurred_at: "2026-06-10T10:30:00",
	body: [{ type: "text", text: "Bought milk after daycare pickup." }],
};

export const JOURNAL_ENTRY_REVIEW_CONTEXT = {
	current_journal_entry: {
		entity_id: "entry-123",
		occurred_at: "2026-06-10T10:15:00",
		body: [{ type: "text", text: "Bought milk before daycare pickup." }],
	},
} satisfies NonNullable<ProposalGetResult["review_context"]>;

/** Stub WsClient driven by in-memory queues so proposal flows run offline. */
export function makeStubRuntime(opts: {
	proposalQueue: Queue.Queue<ProposalNotification>;
	proposalGet?: (runId: RunId) => Effect.Effect<ProposalGetResult, WsError>;
	runQueue?: Queue.Queue<RunEventValue>;
	runQueues?: Queue.Queue<RunEventValue>[];
	onDecide?: (
		params: ProposalDecideParams,
	) => Effect.Effect<ProposalDecideResult, WsError>;
	onSubscribe?: () => void;
	threadGet?: (threadId: string) => Effect.Effect<ThreadGetResult, WsError>;
}) {
	let subscribeIndex = 0;
	const overrides = {
		subscribeRun: () => {
			opts.onSubscribe?.();
			if (opts.runQueues) {
				const queue = opts.runQueues[subscribeIndex];
				subscribeIndex += 1;
				return queue ? Stream.fromQueue(queue) : Stream.empty;
			}
			return opts.runQueue ? Stream.fromQueue(opts.runQueue) : Stream.empty;
		},
		proposalGet:
			opts.proposalGet ??
			((runId) =>
				Effect.succeed({
					proposal_id: "prop-1",
					run_id: runId,
					mutation_kind: "create_journal_entry",
					payload: JOURNAL_ENTRY,
					rationale: "the user asked to remember this",
					status: "pending",
				})),
		proposalDecide:
			opts.onDecide ??
			((params) =>
				Effect.succeed({
					status: params.decision === "accept" ? "accepted" : "rejected",
				})),
		proposalNotifications: () => Stream.fromQueue(opts.proposalQueue),
	};
	return makeCoreRuntime({
		overrides:
			opts.threadGet === undefined
				? overrides
				: { ...overrides, threadGet: opts.threadGet },
	});
}
