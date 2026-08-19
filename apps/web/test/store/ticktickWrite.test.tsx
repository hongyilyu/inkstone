// The TickTick write family's store plumbing (ticktick-writes W3): the decide
// response's write outcome, the -32005 stale flip, the changed-notification
// state carry, and the bounded observe-poll's one tick.

import type { ProposalNotification } from "@inkstone/ui-sdk";
import { StaleConnectionError } from "@inkstone/ui-sdk";
import { Effect, Queue } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	decideProposal,
	pollTickTickWriteOnce,
	resetBridge,
	startProposalStream,
} from "@/store/bridge.js";
import {
	appendMessage,
	attachRun,
	beginRunSubscription,
	getChatState,
	nextMessageId,
	rehydrateDecidedProposal,
	resetChatStore,
	setPendingProposal,
} from "@/store/chat.js";
import { makeStubRuntime } from "./proposal.test-support.js";
import { threadWithWriteSegment } from "./ticktickWrite.test-support.js";

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

const TICKTICK_PROPOSAL = {
	proposal_id: "prop-tt-1",
	run_id: "run-1",
	mutation_kind: "create_ticktick_task",
	payload: { title: "buy milk" },
	rationale: "the user asked",
	status: "pending",
} as const;

/** Seed thread-1 with an assistant turn attached to run-1 (the poll and the
 * resume path both resolve the thread through the run record). */
function seedRunTurn(): void {
	const assistantId = nextMessageId();
	appendMessage("thread-1", {
		id: assistantId,
		role: "assistant",
		status: "streaming",
		segments: [],
		run_id: "",
	});
	attachRun("thread-1", assistantId, "run-1");
	// Materialize the run record (threadId lookup) the way a live/hydrated
	// subscription would.
	beginRunSubscription("thread-1", "run-1");
}

describe("decideProposal — the write family", () => {
	it("persists the decide response's ticktick_write on the record", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({
			proposalQueue,
			onDecide: () =>
				Effect.succeed({
					status: "accepted" as const,
					ticktick_write: {
						state: "created" as const,
						task_id: "tt-1",
					},
				}),
		});
		seedRunTurn();
		setPendingProposal(TICKTICK_PROPOSAL);

		await decideProposal(runtime, "run-1", "accept");

		const settled = getChatState().proposals["run-1"];
		expect(settled?.status).toBe("accepted");
		expect(settled?.ticktick_write).toEqual({
			state: "created",
			task_id: "tt-1",
		});
		await runtime.dispose();
	});

	it("-32005 flips the record to the derived stale pending state (never a refetch loop)", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({
			proposalQueue,
			onDecide: () =>
				Effect.fail(
					new StaleConnectionError({
						message:
							"the TickTick connection changed since this was proposed — reject it and ask again",
					}),
				),
		});
		seedRunTurn();
		setPendingProposal({
			...TICKTICK_PROPOSAL,
			ticktick_write: { state: "proposed", stale_connection: false },
		});

		await decideProposal(runtime, "run-1", "accept");

		const record = getChatState().proposals["run-1"];
		expect(record?.status).toBe("pending");
		expect(record?.ticktick_write).toEqual({
			state: "proposed",
			stale_connection: true,
		});
		await runtime.dispose();
	});

	it("a changed notification carries the write state onto the record", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({ proposalQueue });
		seedRunTurn();
		setPendingProposal(TICKTICK_PROPOSAL);

		startProposalStream(runtime);
		Queue.unsafeOffer(proposalQueue, {
			kind: "changed",
			run_id: "run-1",
			proposal_id: "prop-tt-1",
			status: "accepted",
			ticktick_write: { state: "executing", deadline_at: 1_755_600_000_000 },
		});
		await vi.waitUntil(
			() => getChatState().proposals["run-1"]?.status === "accepted",
		);
		expect(getChatState().proposals["run-1"]?.ticktick_write).toEqual({
			state: "executing",
			deadline_at: 1_755_600_000_000,
		});
		await runtime.dispose();
	});
});

describe("pollTickTickWriteOnce — the bounded observe-poll's tick", () => {
	it("keeps observing while the durable read still says executing", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({
			proposalQueue,
			threadGet: () =>
				Effect.succeed(
					threadWithWriteSegment({
						state: "executing",
						deadline_at: Date.now() + 60_000,
					}),
				),
		});
		seedRunTurn();
		rehydrateDecidedProposal({
			...TICKTICK_PROPOSAL,
			payload: null,
			status: "accepted",
			ticktick_write: {
				state: "executing",
				deadline_at: Date.now() + 60_000,
			},
		});

		await expect(pollTickTickWriteOnce(runtime, "run-1")).resolves.toBe(
			"executing",
		);
		expect(getChatState().proposals["run-1"]?.ticktick_write?.state).toBe(
			"executing",
		);
		await runtime.dispose();
	});

	it("applies the recorded outcome when the read settled (observation only)", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({
			proposalQueue,
			threadGet: () =>
				Effect.succeed(
					threadWithWriteSegment({ state: "created", task_id: "tt-9" }),
				),
		});
		seedRunTurn();
		rehydrateDecidedProposal({
			...TICKTICK_PROPOSAL,
			payload: null,
			status: "accepted",
			ticktick_write: {
				state: "executing",
				deadline_at: Date.now() + 60_000,
			},
		});

		await expect(pollTickTickWriteOnce(runtime, "run-1")).resolves.toBe(
			"settled",
		);
		const record = getChatState().proposals["run-1"];
		expect(record?.status).toBe("accepted");
		expect(record?.ticktick_write).toEqual({
			state: "created",
			task_id: "tt-9",
		});
		await runtime.dispose();
	});

	it("answers gone for a cleared record and survives a transient read failure", async () => {
		const proposalQueue = Effect.runSync(
			Queue.unbounded<ProposalNotification>(),
		);
		const runtime = makeStubRuntime({ proposalQueue });
		await expect(pollTickTickWriteOnce(runtime, "run-none")).resolves.toBe(
			"gone",
		);
		await runtime.dispose();
	});
});
