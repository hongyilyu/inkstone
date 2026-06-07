import {
	type ProposalNotification,
	type RunEventValue,
	type RunId,
	WsClient,
} from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
	awaitProposalStream,
	decideProposal,
	resetBridge,
	startProposalStream,
} from "./bridge.js";
import { getChatState, resetChatStore } from "./chat.js";

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
}) {
	const unused = Effect.die("not exercised");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () => unused,
		threadGet: () => unused,
		subscribeRun: () =>
			opts.runQueue ? Stream.fromQueue(opts.runQueue) : Stream.empty,
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
		proposalDecide: (params) =>
			Effect.succeed({
				status: params.decision === "accept" ? "accepted" : "rejected",
			} as const),
		proposalNotifications: () => Stream.fromQueue(opts.proposalQueue),
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
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
		// Close the stream so the fiber settles and the test can await it.
		await Queue.shutdown(proposalQueue);
		await awaitProposalStream(runtime);

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
		await Queue.shutdown(proposalQueue);
		await awaitProposalStream(runtime);

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
		await Queue.shutdown(proposalQueue);
		await awaitProposalStream(runtime);

		await decideProposal(runtime, "run-1", "accept");

		expect(getChatState().proposals["run-1"]?.status).toBe("accepted");

		await runtime.dispose();
	});
});
