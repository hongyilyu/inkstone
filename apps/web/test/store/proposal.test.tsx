import type {
	ProposalDecideParams,
	ProposalDecideResult,
	ProposalGetResult,
	ThreadGetResult,
} from "@inkstone/protocol";
import {
	InvalidParamsError,
	type ProposalNotification,
	ProposalNotPendingError,
	type RunEventValue,
	type RunId,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { makeCoreRuntime } from "@test/test-utils/renderWithCore";
import { Effect, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	decideProposal,
	resetBridge,
	startProposalStream,
	startRunStream,
} from "@/store/bridge.js";
import {
	appendMessage,
	attachRun,
	clearProposal,
	concatText,
	getChatState,
	nextMessageId,
	resetChatStore,
} from "@/store/chat.js";

const JOURNAL_ENTRY = {
	occurred_at: "2026-06-10T10:30:00",
	body: [{ type: "text", text: "Bought milk after daycare pickup." }],
};

const JOURNAL_ENTRY_REVIEW_CONTEXT = {
	current_journal_entry: {
		entity_id: "entry-123",
		occurred_at: "2026-06-10T10:15:00",
		body: [{ type: "text", text: "Bought milk before daycare pickup." }],
	},
} satisfies NonNullable<ProposalGetResult["review_context"]>;

/** Stub WsClient driven by in-memory queues so proposal flows run offline. */
function makeStubRuntime(opts: {
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
	// Each subscribeRun gets the next queue in runQueues — one stub queue per
	// subscribe SEGMENT (test modeling of the wire, not production plumbing;
	// see docs/design/web-store-tests.md).
	let subscribeIdx = 0;
	return makeCoreRuntime({
		overrides: {
			subscribeRun: () => {
				opts.onSubscribe?.();
				if (opts.runQueues) {
					const q = opts.runQueues[subscribeIdx];
					subscribeIdx += 1;
					return q ? Stream.fromQueue(q) : Stream.empty;
				}
				return opts.runQueue ? Stream.fromQueue(opts.runQueue) : Stream.empty;
			},
			proposalGet:
				opts.proposalGet ??
				((runId: RunId) =>
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
					} as const)),
			proposalNotifications: () => Stream.fromQueue(opts.proposalQueue),
			...(opts.threadGet !== undefined ? { threadGet: opts.threadGet } : {}),
		},
	});
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

describe("proposal stream + decide", () => {
	it("a proposal/pending notification fetches and attaches the pending proposal", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({ proposalQueue });

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		const proposal = getChatState().proposals["run-1"];
		expect(proposal?.status).toBe("pending");
		expect(proposal?.payload).toEqual(JOURNAL_ENTRY);

		await runtime.dispose();
	});

	it("retains proposal review_context from proposal/get in the chat store", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({
			proposalQueue,
			proposalGet: (runId) =>
				Effect.succeed({
					proposal_id: "prop-1",
					run_id: runId,
					mutation_kind: "update_journal_entry",
					payload: {
						entity_id: "entry-123",
						occurred_at: "2026-06-10T10:30:00",
						body: [{ type: "text", text: "Bought milk after daycare pickup." }],
					},
					rationale: "the user corrected the original journal entry",
					review_context: JOURNAL_ENTRY_REVIEW_CONTEXT,
					status: "pending",
				}),
		});

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		expect(getChatState().proposals["run-1"]?.review_context).toEqual(
			JOURNAL_ENTRY_REVIEW_CONTEXT,
		);

		await runtime.dispose();
	});

	it("a proposal/changed notification updates the proposal status", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({ proposalQueue });

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		Queue.unsafeOffer(proposalQueue, {
			kind: "changed",
			run_id: "run-1",
			proposal_id: "prop-1",
			status: "accepted",
		});
		await vi.waitUntil(
			() => getChatState().proposals["run-1"]?.status === "accepted",
		);

		expect(getChatState().proposals["run-1"]?.status).toBe("accepted");

		await runtime.dispose();
	});

	it("decideProposal calls proposalDecide and flips the proposal to its decided state", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime({ proposalQueue, runQueue });

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		expect(getChatState().proposals["run-1"]?.status).toBe("accepted");

		await runtime.dispose();
	});

	it("preserves InvalidParamsError.message when a proposal edit is rejected", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({
			proposalQueue,
			onDecide: () =>
				Effect.fail(
					new InvalidParamsError({
						message: "record_observations payload is invalid",
					}),
				),
		});

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "edit", { observations: [] });

		expect(getChatState().proposals["run-1"]).toMatchObject({
			status: "error",
			error_message: "record_observations payload is invalid",
		});

		await runtime.dispose();
	});

	it("mints one stable decision_idempotency_key across a failed decide and its retry", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const captured: ProposalDecideParams[] = [];
		let decideCalls = 0;
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			// Per-run proposal ids so the fresh-proposal assertion sees a distinct key.
			proposalGet: (runId) =>
				Effect.succeed({
					proposal_id: `prop-${runId}`,
					run_id: runId,
					mutation_kind: "create_journal_entry",
					payload: JOURNAL_ENTRY,
					rationale: "the user asked to remember this",
					status: "pending",
				}),
			onDecide: (params) => {
				captured.push(params);
				decideCalls += 1;
				if (decideCalls === 1) {
					// The first decide is lost mid-flight; the retry must replay the SAME key.
					return Effect.fail(new WsRequestError({ reason: "connection_lost" }));
				}
				return Effect.succeed({ status: "accepted" } as const);
			},
		});

		// Seed run-1's turn + parked stream so the retry's success path can resume it.
		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-run-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		// First decide fails (lost response) → error state with Try again.
		await decideProposal(runtime, "run-1", "accept");
		expect(getChatState().proposals["run-1"]?.status).toBe("error");

		// The retry replays the same decision and succeeds.
		await decideProposal(runtime, "run-1", "accept");
		expect(getChatState().proposals["run-1"]?.status).toBe("accepted");

		const UUID_RE =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		expect(captured).toHaveLength(2);
		expect(captured[0]?.decision_idempotency_key).toMatch(UUID_RE);
		expect(captured[1]?.decision_idempotency_key).toMatch(UUID_RE);
		expect(captured[0]?.decision_idempotency_key).toBe(
			captured[1]?.decision_idempotency_key,
		);

		// A different proposal (fresh run) mints a DIFFERENT key.
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-2",
			proposal_id: "prop-run-2",
		});
		await vi.waitUntil(() => getChatState().proposals["run-2"] !== undefined);
		await decideProposal(runtime, "run-2", "accept");

		expect(captured).toHaveLength(3);
		expect(captured[2]?.decision_idempotency_key).toMatch(UUID_RE);
		expect(captured[2]?.decision_idempotency_key).not.toBe(
			captured[0]?.decision_idempotency_key,
		);

		await runtime.dispose();
	});

	it("settles an already-decided proposal from thread/get on ProposalNotPendingError", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		let subscribeCount = 0;
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onSubscribe: () => {
				subscribeCount += 1;
			},
			// Another tab already decided: every decide fails proposal-not-pending.
			onDecide: () =>
				Effect.fail(
					new ProposalNotPendingError({
						message: "proposal is no longer pending",
					}),
				),
			// Durable truth: thread/get carries the decided proposal segment.
			threadGet: () =>
				Effect.succeed({
					thread_id: "thread-1",
					title: "T",
					messages: [
						{
							id: "m1",
							role: "assistant",
							status: "streaming",
							run_id: "run-1",
							segments: [
								{
									kind: "proposal",
									proposal_id: "prop-1",
									mutation_kind: "create_journal_entry",
									status: "accepted",
									entity_id: "e-1",
								},
							],
						},
					],
				} satisfies ThreadGetResult),
		});

		// Seed run-1's turn + parked stream so settlement can resume it.
		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");
		await vi.waitUntil(() => subscribeCount === 1);

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		// Settled from durable truth, NOT the dead-end error state.
		expect(getChatState().proposals["run-1"]).toMatchObject({
			status: "accepted",
			entity_id: "e-1",
		});
		// The resume tail was re-subscribed, mirroring the success path.
		await vi.waitUntil(() => subscribeCount === 2);

		await runtime.dispose();
	});

	it("falls back to the error state when thread/get carries no decided segment", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onDecide: () =>
				Effect.fail(
					new ProposalNotPendingError({
						message: "proposal is no longer pending",
					}),
				),
			// The -32002 run-not-parked case: durable truth has no DECIDED outcome —
			// the wire status is an open string, so a non-decided value must be
			// skipped, never coerced into a settled pill.
			threadGet: () =>
				Effect.succeed({
					thread_id: "thread-1",
					title: "T",
					messages: [
						{
							id: "m1",
							role: "assistant",
							status: "streaming",
							run_id: "run-1",
							segments: [
								{ kind: "text", text: "still thinking" },
								{
									kind: "proposal",
									proposal_id: "prop-1",
									mutation_kind: "create_journal_entry",
									status: "pending",
								},
							],
						},
					],
				} satisfies ThreadGetResult),
		});

		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		expect(getChatState().proposals["run-1"]?.status).toBe("error");

		await runtime.dispose();
	});

	it("does not settle from a DIFFERENT proposal's decided segment (multi-park run)", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onDecide: () =>
				Effect.fail(
					new ProposalNotPendingError({
						message: "proposal prop-1 is cancelled (not pending)",
					}),
				),
			// A multi-park run: thread/get carries only the MOST-RECENT decided
			// proposal (prop-2). The stale card is for prop-1 — settling it to
			// prop-2's outcome would render an Accept that never happened.
			threadGet: () =>
				Effect.succeed({
					thread_id: "thread-1",
					title: "T",
					messages: [
						{
							id: "m1",
							role: "assistant",
							status: "streaming",
							run_id: "run-1",
							segments: [
								{
									kind: "proposal",
									proposal_id: "prop-2",
									mutation_kind: "create_journal_entry",
									status: "accepted",
									entity_id: "e-2",
								},
							],
						},
					],
				} satisfies ThreadGetResult),
		});

		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		// prop-2's outcome must NOT be stamped onto prop-1's card.
		expect(getChatState().proposals["run-1"]).toMatchObject({
			status: "error",
		});
		expect(getChatState().proposals["run-1"]?.entity_id).toBeUndefined();

		await runtime.dispose();
	});

	it("falls back to the error state when the settle refetch itself fails", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		let subscribeCount = 0;
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onSubscribe: () => {
				subscribeCount += 1;
			},
			onDecide: () =>
				Effect.fail(
					new ProposalNotPendingError({
						message: "proposal is no longer pending",
					}),
				),
			threadGet: () =>
				Effect.fail(new WsRequestError({ reason: "connection_lost" })),
		});

		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");
		await vi.waitUntil(() => subscribeCount === 1);

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		expect(getChatState().proposals["run-1"]?.status).toBe("error");
		// The fallback must NOT re-subscribe the resume tail.
		expect(subscribeCount).toBe(1);

		await runtime.dispose();
	});

	it("settles a cross-tab REJECTED proposal into the dismissed pill", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onDecide: () =>
				Effect.fail(
					new ProposalNotPendingError({
						message: "proposal is no longer pending",
					}),
				),
			// The other tab REJECTED: the decided segment carries no entity_id.
			threadGet: () =>
				Effect.succeed({
					thread_id: "thread-1",
					title: "T",
					messages: [
						{
							id: "m1",
							role: "assistant",
							status: "streaming",
							run_id: "run-1",
							segments: [
								{
									kind: "proposal",
									proposal_id: "prop-1",
									mutation_kind: "create_journal_entry",
									status: "rejected",
								},
							],
						},
					],
				} satisfies ThreadGetResult),
		});

		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		expect(getChatState().proposals["run-1"]?.status).toBe("rejected");
		expect(getChatState().proposals["run-1"]?.entity_id).toBeUndefined();

		await runtime.dispose();
	});

	it("does not write over a proposal cleared while the settle refetch was in flight", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		let subscribeCount = 0;
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onSubscribe: () => {
				subscribeCount += 1;
			},
			onDecide: () =>
				Effect.fail(
					new ProposalNotPendingError({
						message: "proposal is no longer pending",
					}),
				),
			// A concurrent cancelRun clears the proposal mid-refetch: the currency
			// guard must bail — no settled pill, no error write, no re-subscribe.
			threadGet: () => {
				clearProposal("run-1");
				return Effect.succeed({
					thread_id: "thread-1",
					title: "T",
					messages: [
						{
							id: "m1",
							role: "assistant",
							status: "streaming",
							run_id: "run-1",
							segments: [
								{
									kind: "proposal",
									proposal_id: "prop-1",
									mutation_kind: "create_journal_entry",
									status: "accepted",
									entity_id: "e-1",
								},
							],
						},
					],
				} satisfies ThreadGetResult);
			},
		});

		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");
		await vi.waitUntil(() => subscribeCount === 1);

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		expect(getChatState().proposals["run-1"]).toBeUndefined();
		// The guard bail must not re-subscribe the resume tail either.
		expect(subscribeCount).toBe(1);

		await runtime.dispose();
	});

	it("a double decide does not flip an accepted card to error (M1)", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		// Second decide (double-click) would fail proposal_not_pending; the store guard must stop it.
		let decideCalls = 0;
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onDecide: () => {
				decideCalls += 1;
				if (decideCalls === 1) {
					return Effect.succeed({ status: "accepted" } as const);
				}
				return Effect.fail(
					new WsRequestError({ reason: "proposal_not_pending" }),
				);
			},
		});

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		// Second observes the optimistic `deciding` status from the first and short-circuits.
		const first = decideProposal(runtime, "run-1", "accept");
		const second = decideProposal(runtime, "run-1", "accept");
		await Promise.all([first, second]);

		expect(decideCalls).toBe(1);
		expect(getChatState().proposals["run-1"]?.status).toBe("accepted");

		await runtime.dispose();
	});

	it("re-subscribes with a single consumer so the resume tail is not split (M2)", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		let subscribeCount = 0;
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onSubscribe: () => {
				subscribeCount += 1;
			},
		});

		// Seed run-1's turn + start the original parked stream (no terminal event → stale fiber, M2).
		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");
		await vi.waitUntil(() => subscribeCount === 1);

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");
		// Decide re-subscribed exactly once more (original fiber interrupted, not abandoned).
		await vi.waitUntil(() => subscribeCount === 2);

		// Single-consumer resume tail: deltas concatenate cleanly; two consumers would split them.
		Queue.unsafeOffer(runQueue, { kind: "text_delta", delta: "Done" });
		Queue.unsafeOffer(runQueue, { kind: "text_delta", delta: ". " });
		Queue.unsafeOffer(runQueue, { kind: "text_delta", delta: "added it." });
		Queue.unsafeOffer(runQueue, { kind: "done" });

		await vi.waitUntil(() => {
			const msg = getChatState().threads["thread-1"]?.messages.find(
				(m) => m.run_id === "run-1",
			);
			return msg?.status === "completed";
		});

		const msg = getChatState().threads["thread-1"]?.messages.find(
			(m) => m.run_id === "run-1",
		);
		expect(concatText(msg?.segments ?? [])).toBe("Done. added it.");

		await runtime.dispose();
	});

	it("resume snapshot SETs (not appends) cumulative text after pre-park prose (M1)", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		// Distinct stub queues per subscribe segment — test modeling of each wire
		// segment, not production plumbing (docs/design/web-store-tests.md).
		const parkedQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const resumeQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueues: [parkedQueue, resumeQueue],
		});

		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");

		// Original subscribe: first delta is the cumulative snapshot (SET), then parks (no terminal).
		Queue.unsafeOffer(parkedQueue, {
			kind: "text_delta",
			delta: "Let me check the other thread. ",
		});
		await vi.waitUntil(() => {
			const msg = getChatState().threads["thread-1"]?.messages.find(
				(m) => m.run_id === "run-1",
			);
			return (
				concatText(msg?.segments ?? []) === "Let me check the other thread. "
			);
		});

		// Park + decide → resume re-subscribe whose snapshot re-includes the pre-park prose.
		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		// Resume tail: first delta is the cumulative snapshot → SET (not append); rest APPEND.
		Queue.unsafeOffer(resumeQueue, {
			kind: "text_delta",
			delta: "Let me check the other thread. ",
		});
		Queue.unsafeOffer(resumeQueue, {
			kind: "text_delta",
			delta: "Done — added it.",
		});
		Queue.unsafeOffer(resumeQueue, { kind: "done" });

		await vi.waitUntil(() => {
			const msg = getChatState().threads["thread-1"]?.messages.find(
				(m) => m.run_id === "run-1",
			);
			return msg?.status === "completed";
		});

		const msg = getChatState().threads["thread-1"]?.messages.find(
			(m) => m.run_id === "run-1",
		);
		// SET replaces the on-screen prefix; the M1 bug appended → duplicated prefix.
		expect(concatText(msg?.segments ?? [])).toBe(
			"Let me check the other thread. Done — added it.",
		);

		await runtime.dispose();
	});

	it("resume-after-park lands the reply AFTER the proposal segment, no duplicated prefix (ADR-0045)", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const parkedQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const resumeQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueues: [parkedQueue, resumeQueue],
		});

		const assistantId = nextMessageId();
		appendMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");

		// Pre-park prose (snapshot SET), then park.
		Queue.unsafeOffer(parkedQueue, {
			kind: "text_delta",
			delta: "Let me check the other thread. ",
		});
		await vi.waitUntil(() => {
			const msg = getChatState().threads["thread-1"]?.messages.find(
				(m) => m.run_id === "run-1",
			);
			return (
				concatText(msg?.segments ?? []) === "Let me check the other thread. "
			);
		});

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await vi.waitUntil(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		// Resume: the snapshot re-includes the pre-park prose (armed SET → reconciles
		// the EXISTING pre-park text segment, not a duplicate after the proposal), then
		// the genuine reply opens a NEW text segment after the proposal marker.
		Queue.unsafeOffer(resumeQueue, {
			kind: "text_delta",
			delta: "Let me check the other thread. ",
		});
		Queue.unsafeOffer(resumeQueue, {
			kind: "text_delta",
			delta: "Done — added it.",
		});
		Queue.unsafeOffer(resumeQueue, { kind: "done" });

		await vi.waitUntil(() => {
			const msg = getChatState().threads["thread-1"]?.messages.find(
				(m) => m.run_id === "run-1",
			);
			return msg?.status === "completed";
		});

		const msg = getChatState().threads["thread-1"]?.messages.find(
			(m) => m.run_id === "run-1",
		);
		// search → propose → accept → reply: the timeline is pre-park text, the
		// proposal marker, THEN the reply. The pre-park prefix appears exactly once.
		expect(msg?.segments).toEqual([
			{ kind: "text", text: "Let me check the other thread. " },
			{ kind: "proposal", runId: "run-1" },
			{ kind: "text", text: "Done — added it." },
		]);
		// The render-source invariant: concatText(segments) === the flat reply text.
		expect(concatText(msg?.segments ?? [])).toBe(
			"Let me check the other thread. Done — added it.",
		);

		await runtime.dispose();
	});
});
