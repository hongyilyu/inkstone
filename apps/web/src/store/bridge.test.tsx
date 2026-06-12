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

// A stub WsClient whose `threadCreate` FAILS, exercised through the slice-10
// RuntimeProvider injection seam: a runtime built from
// `ManagedRuntime.make(Layer.succeed(WsClient, stub))` (no real socket). Only
// `threadCreate` runs on the `sendNewThread` path; the rest are never reached.
function makeFailingThreadCreateRuntime() {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => Effect.fail(new WsRequestError({ reason: "boom" })),
		postMessage: () => unused,
		threadList: () => unused,
		threadGet: () => unused,
		listEntities: () => unused,
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
		// No thread was minted and nothing got focused — nothing to clean up.
		expect(Object.keys(getChatState().threads)).toHaveLength(0);
		expect(getChatState().focusedThreadId).toBeUndefined();

		await runtime.dispose();
	});
});

describe("decideProposal resume fiber tracking (M2)", () => {
	it("leaves the resume fiber interruptible after the stale finalizer runs", async () => {
		// Both subscribes return a never-terminating stream (a parked/resume tail
		// with no terminal event yet), so a fiber ends ONLY via interruption.
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

		// Seed a parked run + its original (parked) subscribe fiber + a Proposal.
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

		// Accept → interruptRun(old) then startRunStream(resume). The interrupted
		// old fiber's finalizer fires asynchronously AFTER the resume fiber is set.
		await decideProposal(runtime, runId, "accept");
		expect(subscribeRun).toHaveBeenCalledTimes(2);

		// Give the stale finalizer its chance to run (the clobber window). With the
		// M2 bug it deletes the NEWLY-set resume fiber's entry; with the fix it is a
		// no-op because the map no longer points at the interrupted fiber.
		await new Promise((r) => setTimeout(r, 0));

		// The resume fiber must still be tracked. With the M2 clobber the stale
		// finalizer deleted the resume fiber's entry, so it is untracked here — a
		// leak the app can never interrupt (and a second decide would split the
		// tail across two consumers). The fix keeps it tracked.
		expect(hasRunFiber(runId)).toBe(true);
		// And it is genuinely interruptible: interruptRun removes the tracked entry.
		interruptRun(runtime, runId);
		expect(hasRunFiber(runId)).toBe(false);

		await runtime.dispose();
	});
});
