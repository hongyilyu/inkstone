import type {
	ProposalDecideParams,
	ProposalDecideResult,
} from "@inkstone/protocol";
import {
	type ProposalNotification,
	type RunEventValue,
	type RunId,
	WsClient,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
	decideProposal,
	resetBridge,
	startProposalStream,
	startRunStream,
} from "./bridge.js";
import {
	attachRun,
	getChatState,
	nextMessageId,
	resetChatStore,
	seedAssistantMessage,
} from "./chat.js";

const TODO = { title: "buy milk", done: false };

/**
 * A stub WsClient driven by in-memory queues: one for the global
 * `proposalNotifications()` stream and one per run for `subscribeRun`. The
 * proposal/* request methods resolve from fixtures so the bridge's
 * fetch-on-pending and decide flows can be exercised offline.
 */
function makeStubRuntime(opts: {
	proposalQueue: Queue.Queue<ProposalNotification>;
	runQueue?: Queue.Queue<RunEventValue>;
	onDecide?: (
		params: ProposalDecideParams,
	) => Effect.Effect<ProposalDecideResult, WsError>;
	onSubscribe?: () => void;
}) {
	const unused = Effect.die("not exercised");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		threadGet: () => unused,
		subscribeRun: () => {
			opts.onSubscribe?.();
			return opts.runQueue ? Stream.fromQueue(opts.runQueue) : Stream.empty;
		},
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: (runId: RunId) =>
			Effect.succeed({
				proposal_id: "prop-1",
				run_id: runId,
				kind: "todo",
				change_kind: "create",
				data: TODO,
				rationale: "the user asked to remember this",
				status: "pending",
			}),
		proposalDecide:
			opts.onDecide ??
			((params) =>
				Effect.succeed({
					status: params.decision === "accept" ? "accepted" : "rejected",
				} as const)),
		proposalNotifications: () => Stream.fromQueue(opts.proposalQueue),
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

/** Poll the store until `predicate` holds (the stream fiber is async). */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("waitFor timed out");
}

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
		await waitFor(() => getChatState().proposals["run-1"] !== undefined);

		const proposal = getChatState().proposals["run-1"];
		expect(proposal?.status).toBe("pending");
		expect(proposal?.data).toEqual(TODO);

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
		await waitFor(
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

		// Seed a pending proposal first.
		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await waitFor(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");

		expect(getChatState().proposals["run-1"]?.status).toBe("accepted");

		await runtime.dispose();
	});

	it("a double decide does not flip an accepted card to error (M1)", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runQueue = Effect.runSync(Queue.unbounded<RunEventValue>());
		// The first decide succeeds; a second (the double-click) would hit Core
		// after the Run un-parked → `proposal_not_pending` → fail. The store
		// guard must stop the second call entirely.
		let decideCalls = 0;
		const runtime = makeStubRuntime({
			proposalQueue,
			runQueue,
			onDecide: () => {
				decideCalls += 1;
				if (decideCalls === 1) {
					return Effect.succeed({ status: "accepted" } as const);
				}
				return Effect.fail(new WsRequestError({ reason: "proposal_not_pending" }));
			},
		});

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await waitFor(() => getChatState().proposals["run-1"] !== undefined);

		// Fire twice back-to-back (the double-click). The second observes the
		// optimistic `deciding` status set by the first and short-circuits.
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

		// Seed the assistant turn that holds run-1, then start the ORIGINAL
		// parked stream (which never gets a terminal event, so its fiber stays
		// blocked on the run queue — the stale fiber M2 is about).
		const assistantId = nextMessageId();
		seedAssistantMessage("thread-1", {
			id: assistantId,
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "",
		});
		attachRun("thread-1", assistantId, "run-1");
		startRunStream(runtime, "thread-1", "run-1");
		await waitFor(() => subscribeCount === 1);

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "pending",
			run_id: "run-1",
			proposal_id: "prop-1",
		});
		await waitFor(() => getChatState().proposals["run-1"] !== undefined);

		await decideProposal(runtime, "run-1", "accept");
		// The decide re-subscribed exactly once more (the original fiber was
		// interrupted, not abandoned).
		await waitFor(() => subscribeCount === 2);

		// Stream a MULTI-chunk resume tail. With a single consumer the deltas
		// concatenate cleanly; two consumers would split them and corrupt the
		// text. The first delta is the cumulative snapshot (SET), the rest APPEND.
		Queue.unsafeOffer(runQueue, { kind: "text_delta", delta: "Done" });
		Queue.unsafeOffer(runQueue, { kind: "text_delta", delta: ". " });
		Queue.unsafeOffer(runQueue, { kind: "text_delta", delta: "added it." });
		Queue.unsafeOffer(runQueue, { kind: "done" });

		await waitFor(() => {
			const msg = getChatState().threads["thread-1"]?.messages.find(
				(m) => m.run_id === "run-1",
			);
			return msg?.status === "completed";
		});

		const msg = getChatState().threads["thread-1"]?.messages.find(
			(m) => m.run_id === "run-1",
		);
		expect(msg?.text).toBe("Done. added it.");

		await runtime.dispose();
	});
});
