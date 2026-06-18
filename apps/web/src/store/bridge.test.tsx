import {
	type RunEventValue,
	type RunId,
	WsClient,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WsRuntime } from "../runtime.js";
import {
	cancelRun as cancelRunBridge,
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
	setProposalStatus,
} from "./chat.js";

// Stub WsClient whose threadCreate fails; only that runs on the sendNewThread path.
function makeFailingThreadCreateRuntime() {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => Effect.fail(new WsRequestError({ reason: "boom" })),
		postMessage: () => unused,
		threadList: () => unused,
		getRunHistory: () => unused,
		threadGet: () => unused,
		listEntities: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
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

		// No threadId is surfaced for the caller to navigate to, and nothing was seeded.
		expect(result).toEqual({ ok: false, error: expect.anything() });
		expect(Object.keys(getChatState().threads)).toHaveLength(0);

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
			getRunHistory: () => Effect.die("unused"),
			threadGet: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			cancelRun: () => Effect.die("unused"),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			proposalDecide: () =>
				Effect.succeed({ status: "accepted" as const, entity_id: "e1" }),
			messageSearch: () => Effect.die("unused"),
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

describe("cancelRun (ADR-0014)", () => {
	/** A stub whose subscribeRun never terminates and whose cancelRun returns `outcome`. */
	function makeCancelRuntime(outcome: {
		readonly outcome: "accepted" | "already_terminal" | "unknown_run";
	}) {
		const cancelRun = vi.fn(() => Effect.succeed(outcome));
		const subscribeRun = vi.fn(
			(_runId: RunId): Stream.Stream<RunEventValue, WsError> =>
				Stream.fromQueue(Effect.runSync(Queue.unbounded<RunEventValue>())),
		);
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			threadGet: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			cancelRun,
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
		});
		return {
			runtime: ManagedRuntime.make(Layer.succeed(WsClient, stub)),
			cancelRun,
		};
	}

	/** Seed a streaming-or-parked assistant turn whose Run is being watched. */
	function seedActiveRun(runId: RunId, runtime: WsRuntime) {
		appendUserMessage("t1", {
			id: "u1",
			role: "user",
			status: "completed",
			text: "hi",
			run_id: "",
		});
		seedAssistantMessage("t1", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			text: "echo: h",
			run_id: "",
		});
		attachRun("t1", "a1", runId);
		startRunStream(runtime, "t1", runId);
	}

	it("on accepted: settles the bubble incomplete, interrupts the fiber, and clears any proposal", async () => {
		const { runtime, cancelRun } = makeCancelRuntime({ outcome: "accepted" });
		const runId = "run-cancel" as RunId;
		seedActiveRun(runId, runtime);
		setPendingProposal({
			proposal_id: "p1",
			run_id: runId,
			mutation_kind: "create_journal_entry",
			payload: {},
			rationale: null,
			status: "pending",
		});

		await cancelRunBridge(runtime, runId);

		expect(cancelRun).toHaveBeenCalledWith(runId);
		// Authoritative response settles the turn even though no stream event arrives (the parked case).
		const thread = getChatState().threads.t1;
		expect(thread?.messages.find((m) => m.id === "a1")?.status).toBe(
			"incomplete",
		);
		expect(thread?.activeRunId).toBeUndefined();
		// The parked Proposal is gone (nothing left to review), and the fiber is dropped.
		expect(getChatState().proposals[runId]).toBeUndefined();
		expect(hasRunFiber(runId)).toBe(false);

		await runtime.dispose();
	});

	it("on already_terminal for a RUNNING run: leaves it untouched (the stream owns the final state)", async () => {
		const { runtime, cancelRun } = makeCancelRuntime({
			outcome: "already_terminal",
		});
		const runId = "run-late" as RunId;
		seedActiveRun(runId, runtime);

		await cancelRunBridge(runtime, runId);

		expect(cancelRun).toHaveBeenCalledWith(runId);
		const thread = getChatState().threads.t1;
		// Not fabricated terminal: the bubble stays streaming and the fiber stays tracked.
		expect(thread?.messages.find((m) => m.id === "a1")?.status).toBe(
			"streaming",
		);
		expect(thread?.activeRunId).toBe(runId);
		expect(hasRunFiber(runId)).toBe(true);

		interruptRun(runtime, runId);
		await runtime.dispose();
	});

	it("on already_terminal for a PARKED run: still settles (no stream would ever clear it)", async () => {
		const { runtime, cancelRun } = makeCancelRuntime({
			outcome: "already_terminal",
		});
		const runId = "run-parked" as RunId;
		seedActiveRun(runId, runtime);
		// Parked awaiting a decision: no live resume stream will deliver a terminal
		// event, so a non-accepted cancel must still settle the bubble + activeRunId.
		setPendingProposal({
			proposal_id: "p1",
			run_id: runId,
			mutation_kind: "create_journal_entry",
			payload: {},
			rationale: null,
			status: "pending",
		});

		await cancelRunBridge(runtime, runId);

		expect(cancelRun).toHaveBeenCalledWith(runId);
		const thread = getChatState().threads.t1;
		expect(thread?.messages.find((m) => m.id === "a1")?.status).toBe(
			"incomplete",
		);
		expect(thread?.activeRunId).toBeUndefined();
		expect(getChatState().proposals[runId]).toBeUndefined();
		expect(hasRunFiber(runId)).toBe(false);

		await runtime.dispose();
	});

	it("on unknown_run for a RUNNING run: still settles (Core has no run/hub, so no stream event will ever come)", async () => {
		const { runtime, cancelRun } = makeCancelRuntime({
			outcome: "unknown_run",
		});
		const runId = "run-unknown" as RunId;
		seedActiveRun(runId, runtime);

		await cancelRunBridge(runtime, runId);

		expect(cancelRun).toHaveBeenCalledWith(runId);
		const thread = getChatState().threads.t1;
		// unknown_run means no fiber will ever see a terminal event — settle here
		// or the fiber leaks and Stop wedges forever.
		expect(thread?.messages.find((m) => m.id === "a1")?.status).toBe(
			"incomplete",
		);
		expect(thread?.activeRunId).toBeUndefined();
		expect(hasRunFiber(runId)).toBe(false);

		await runtime.dispose();
	});

	it("best-effort: a failed run/cancel request leaves the Run as-is", async () => {
		const subscribeRun = vi.fn(
			(_runId: RunId): Stream.Stream<RunEventValue, WsError> =>
				Stream.fromQueue(Effect.runSync(Queue.unbounded<RunEventValue>())),
		);
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			threadGet: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			cancelRun: () => Effect.fail(new WsRequestError({ reason: "boom" })),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		const runId = "run-fail" as RunId;
		seedActiveRun(runId, runtime);

		await cancelRunBridge(runtime, runId);

		// A failed request must NOT fabricate a terminal: the run is untouched.
		const thread = getChatState().threads.t1;
		expect(thread?.messages.find((m) => m.id === "a1")?.status).toBe(
			"streaming",
		);
		expect(thread?.activeRunId).toBe(runId);
		expect(hasRunFiber(runId)).toBe(true);

		interruptRun(runtime, runId);
		await runtime.dispose();
	});

	it("racing decideProposal(accept) then cancelRun: the resumed stream is not re-forked over the cancelled Run", async () => {
		// cancelRun resolves immediately (accepted); proposalDecide resolves only
		// when released, so we drive the exact ordering: cancel settles + clears the
		// Proposal, THEN the decide's await resolves and must NOT re-fork a stream.
		let releaseDecide!: () => void;
		const decideGate = new Promise<void>((resolve) => {
			releaseDecide = resolve;
		});
		const subscribeRun = vi.fn(
			(_runId: RunId): Stream.Stream<RunEventValue, WsError> =>
				Stream.fromQueue(Effect.runSync(Queue.unbounded<RunEventValue>())),
		);
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			threadGet: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			cancelRun: () => Effect.succeed({ outcome: "accepted" as const }),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			proposalDecide: () =>
				Effect.promise(() => decideGate).pipe(
					Effect.as({ status: "accepted" as const, entity_id: "e1" }),
				),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		const runId = "run-race" as RunId;
		seedActiveRun(runId, runtime);
		setPendingProposal({
			proposal_id: "p1",
			run_id: runId,
			mutation_kind: "create_journal_entry",
			payload: {},
			rationale: null,
			status: "pending",
		});

		// Accept is in flight (gated); Stop wins and settles the cancelled Run.
		const deciding = decideProposal(runtime, runId, "accept");
		await cancelRunBridge(runtime, runId);
		expect(getChatState().proposals[runId]).toBeUndefined();
		expect(hasRunFiber(runId)).toBe(false);

		// Now the decide response lands: it must bail (Proposal gone), not re-fork.
		releaseDecide();
		await deciding;

		const thread = getChatState().threads.t1;
		expect(thread?.messages.find((m) => m.id === "a1")?.status).toBe(
			"incomplete",
		);
		expect(thread?.activeRunId).toBeUndefined();
		// No resumed stream was forked over the just-cancelled Run.
		expect(hasRunFiber(runId)).toBe(false);
		expect(subscribeRun).toHaveBeenCalledTimes(1); // only the original seed

		await runtime.dispose();
	});

	it("on already_terminal while a proposal is DECIDING: still settles (no resume stream exists yet)", async () => {
		const { runtime } = makeCancelRuntime({ outcome: "already_terminal" });
		const runId = "run-deciding" as RunId;
		seedActiveRun(runId, runtime);
		// decideProposal sets `deciding` BEFORE re-forking the resume stream, so the
		// Run is still parked with no live tail — a non-accepted cancel must settle.
		setPendingProposal({
			proposal_id: "p1",
			run_id: runId,
			mutation_kind: "create_journal_entry",
			payload: {},
			rationale: null,
			status: "pending",
		});
		setProposalStatus(runId, "deciding");

		await cancelRunBridge(runtime, runId);

		const thread = getChatState().threads.t1;
		expect(thread?.messages.find((m) => m.id === "a1")?.status).toBe(
			"incomplete",
		);
		expect(thread?.activeRunId).toBeUndefined();
		expect(getChatState().proposals[runId]).toBeUndefined();
		expect(hasRunFiber(runId)).toBe(false);

		await runtime.dispose();
	});
});
