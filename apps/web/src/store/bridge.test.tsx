import {
	type RunEventValue,
	type RunId,
	WsClient,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	decideProposal,
	hasRunFiber,
	interruptRun,
	resetBridge,
	sendNewThread,
	startRunStream,
} from "./bridge.js";
import {
	appendUserMessage,
	attachRun,
	getChatState,
	resetChatStore,
	seedAssistantMessage,
	setPendingProposal,
} from "./chat.js";

// Stub WsClient whose threadCreate fails; only that runs on the sendNewThread path.
function makeFailingThreadCreateRuntime() {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => Effect.fail(new WsRequestError({ reason: "boom" })),
		postMessage: () => unused,
		threadList: () => unused,
		threadGet: () => unused,
		listEntities: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		proposalNotifications: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

describe("sendNewThread failure handling", () => {
	it("surfaces a failed threadCreate as { ok: false } instead of swallowing it", async () => {
		const runtime = makeFailingThreadCreateRuntime();

		const result = await sendNewThread(runtime, "hi");

		expect(result).toEqual({ ok: false, error: expect.anything() });
		expect(Object.keys(getChatState().threads)).toHaveLength(0);
		expect(getChatState().focusedThreadId).toBeUndefined();

		await runtime.dispose();
	});
});

describe("decideProposal resume fiber tracking (M2)", () => {
	it("leaves the resume fiber interruptible after the stale finalizer runs", async () => {
		// Both subscribes never terminate, so a fiber ends only via interruption.
		const subscribeRun = vi.fn(
			(_runId: RunId): Stream.Stream<RunEventValue, WsError> =>
				Stream.fromQueue(Effect.runSync(Queue.unbounded<RunEventValue>())),
		);
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			threadGet: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			proposalDecide: () =>
				Effect.succeed({ status: "accepted" as const, entity_id: "e1" }),
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));

		// Seed a parked run + its original (parked) subscribe fiber + a proposal.
		const runId = "run-resume" as RunId;
		appendUserMessage("t1", {
			id: "u1",
			role: "user",
			status: "completed",
			text: "hi",
			run_id: runId,
		});
		seedAssistantMessage("t1", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "",
		});
		attachRun("t1", "a1", runId);
		startRunStream(runtime, "t1", runId); // parked subscribe
		setPendingProposal({
			proposal_id: "p1",
			run_id: runId,
			mutation_kind: "create_journal_entry",
			payload: {},
			rationale: null,
			status: "pending",
		});

		// Accept → interruptRun(old) then startRunStream(resume); old finalizer fires after.
		await decideProposal(runtime, runId, "accept");
		expect(subscribeRun).toHaveBeenCalledTimes(2);

		// Let the stale finalizer run (the clobber window).
		await new Promise((r) => setTimeout(r, 0));

		// Resume fiber must stay tracked — the M2 clobber, see docs/design/web-store-tests.md
		expect(hasRunFiber(runId)).toBe(true);
		// And it is genuinely interruptible: interruptRun removes the tracked entry.
		interruptRun(runtime, runId);
		expect(hasRunFiber(runId)).toBe(false);

		await runtime.dispose();
	});
});
