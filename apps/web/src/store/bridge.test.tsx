import type { ThreadListResult } from "@inkstone/protocol";
import * as sdk from "@inkstone/ui-sdk";
import {
	type RunEventValue,
	type RunId,
	WsClient,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { QueryClient } from "@tanstack/react-query";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WsRuntime } from "../runtime.js";
import {
	applyThreadTitled,
	cancelRun as cancelRunBridge,
	decideProposal,
	hasRunFiber,
	interruptRun,
	registerThreadTitledHandler,
	resetBridge,
	sendNewThread,
	setOnRunSettled,
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
		recurrencePreview: () => Effect.die("not exercised in this test"),
		threadGet: () => unused,
		threadRename: () => unused,
		threadArchive: () => unused,
		threadUnarchive: () => unused,
		threadListArchived: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		rescanJournalEntry: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
		connectionStatus: () => Stream.empty,
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

describe("onRunSettled (terminal seam → recent-Runs refresh)", () => {
	/** A stub whose subscribeRun replays a fixed event sequence then closes. */
	function makeRuntime(events: RunEventValue[]) {
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: () => Effect.die("unused"),
			threadRename: () => Effect.die("unused"),
			threadArchive: () => Effect.die("unused"),
			threadUnarchive: () => Effect.die("unused"),
			threadListArchived: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			getBacklinks: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun: () => Stream.fromIterable<RunEventValue>(events),
			cancelRun: () => Effect.die("unused"),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			rescanJournalEntry: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		return ManagedRuntime.make(Layer.succeed(WsClient, stub));
	}

	function seed(runId: RunId) {
		seedAssistantMessage("t1", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun("t1", "a1", runId);
	}

	it("fires once when a Run reaches a terminal — regardless of focus (background completions)", async () => {
		const settled = vi.fn();
		setOnRunSettled(settled);
		const runtime = makeRuntime([
			{ kind: "text_delta", delta: "hi" },
			{ kind: "done" },
		]);
		const runId = "run-term" as RunId;
		seed(runId);
		startRunStream(runtime, "t1", runId);

		// Drain the stream fiber to its terminal.
		await new Promise((r) => setTimeout(r, 0));
		expect(settled).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("fires on a transport failure too (the synthetic error path settles the feed)", async () => {
		const settled = vi.fn();
		setOnRunSettled(settled);
		// A stream that fails mid-flight rather than emitting a terminal event.
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: () => Effect.die("unused"),
			threadRename: () => Effect.die("unused"),
			threadArchive: () => Effect.die("unused"),
			threadUnarchive: () => Effect.die("unused"),
			threadListArchived: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			getBacklinks: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun: (): Stream.Stream<RunEventValue, WsError> =>
				Stream.fromIterable<RunEventValue>([
					{ kind: "text_delta", delta: "partial" },
				]).pipe(
					Stream.concat(
						Stream.fail(new WsRequestError({ reason: "socket closed" })),
					),
				),
			cancelRun: () => Effect.die("unused"),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			rescanJournalEntry: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		const runId = "run-drop" as RunId;
		seed(runId);
		startRunStream(runtime, "t1", runId);

		await new Promise((r) => setTimeout(r, 0));
		expect(settled).toHaveBeenCalledTimes(1);

		await runtime.dispose();
	});

	it("does NOT fire on an interrupt (no genuine settle → no spurious feed refetch)", async () => {
		const settled = vi.fn();
		setOnRunSettled(settled);
		// A stream that never terminates — the fiber ends only via interruption.
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: () => Effect.die("unused"),
			threadRename: () => Effect.die("unused"),
			threadArchive: () => Effect.die("unused"),
			threadUnarchive: () => Effect.die("unused"),
			threadListArchived: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			getBacklinks: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun: (): Stream.Stream<RunEventValue, WsError> =>
				Stream.fromQueue(Effect.runSync(Queue.unbounded<RunEventValue>())),
			cancelRun: () => Effect.die("unused"),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			rescanJournalEntry: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));
		const runId = "run-interrupt" as RunId;
		seed(runId);
		startRunStream(runtime, "t1", runId);
		await new Promise((r) => setTimeout(r, 0));

		// Interrupt removes the tracked entry BEFORE the finalizer runs, so the
		// identity guard fails and onRunSettled must not fire (this is the
		// decideProposal-resume / unmount teardown, not a terminal).
		interruptRun(runtime, runId);
		await new Promise((r) => setTimeout(r, 0));
		expect(settled).not.toHaveBeenCalled();

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
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: () => Effect.die("unused"),
			threadRename: () => Effect.die("unused"),
			threadArchive: () => Effect.die("unused"),
			threadUnarchive: () => Effect.die("unused"),
			threadListArchived: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			getBacklinks: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			cancelRun: () => Effect.die("unused"),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			rescanJournalEntry: () => Effect.die("unused"),
			proposalDecide: () =>
				Effect.succeed({ status: "accepted" as const, entity_id: "e1" }),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));

		// Seed a parked run + its original (parked) subscribe fiber + a proposal.
		const runId = "run-resume" as RunId;
		appendUserMessage("t1", {
			id: "u1",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "hi" }],
			run_id: runId,
		});
		seedAssistantMessage("t1", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			segments: [],
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
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: () => Effect.die("unused"),
			threadRename: () => Effect.die("unused"),
			threadArchive: () => Effect.die("unused"),
			threadUnarchive: () => Effect.die("unused"),
			threadListArchived: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			getBacklinks: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			cancelRun,
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			rescanJournalEntry: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
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
			segments: [{ kind: "text", text: "hi" }],
			run_id: "",
		});
		seedAssistantMessage("t1", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			segments: [{ kind: "text", text: "echo: h" }],
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
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: () => Effect.die("unused"),
			threadRename: () => Effect.die("unused"),
			threadArchive: () => Effect.die("unused"),
			threadUnarchive: () => Effect.die("unused"),
			threadListArchived: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			getBacklinks: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			cancelRun: () => Effect.fail(new WsRequestError({ reason: "boom" })),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			rescanJournalEntry: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
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
			recurrencePreview: () => Effect.die("not exercised in this test"),
			threadGet: () => Effect.die("unused"),
			threadRename: () => Effect.die("unused"),
			threadArchive: () => Effect.die("unused"),
			threadUnarchive: () => Effect.die("unused"),
			threadListArchived: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			getBacklinks: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			subscribeRun,
			cancelRun: () => Effect.succeed({ outcome: "accepted" as const }),
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			rescanJournalEntry: () => Effect.die("unused"),
			proposalDecide: () =>
				Effect.promise(() => decideGate).pipe(
					Effect.as({ status: "accepted" as const, entity_id: "e1" }),
				),
			messageSearch: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
			connectionStatus: () => Stream.empty,
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

describe("thread/titled handler (ADR-0047 — patch the threads cache in place)", () => {
	/** Seed the `["threads"]` cache with two ordered rows; t1 first (newer). */
	function seedThreads(): QueryClient {
		const qc = new QueryClient();
		qc.setQueryData<ThreadListResult>(["threads"], {
			threads: [
				{ id: "t1", title: "old A", last_activity_at: 2 },
				{ id: "t2", title: "old B", last_activity_at: 1 },
			],
		});
		return qc;
	}

	it("patches the matching thread's title — others, order, and last_activity_at unchanged", () => {
		const qc = seedThreads();

		applyThreadTitled(qc, { thread_id: "t1", title: "new A" });

		const after = qc.getQueryData<ThreadListResult>(["threads"]);
		// Matched row re-titled; the rest verbatim, including last_activity_at (order key).
		expect(after).toEqual({
			threads: [
				{ id: "t1", title: "new A", last_activity_at: 2 },
				{ id: "t2", title: "old B", last_activity_at: 1 },
			],
		});
		// Order preserved: t1 still before t2.
		expect(after?.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
	});

	it("is a no-op for a thread_id not in the cache (does not synthesize a row)", () => {
		const qc = seedThreads();

		applyThreadTitled(qc, { thread_id: "missing", title: "x" });

		const after = qc.getQueryData<ThreadListResult>(["threads"]);
		// Both rows intact, no new row appended.
		expect(after).toEqual({
			threads: [
				{ id: "t1", title: "old A", last_activity_at: 2 },
				{ id: "t2", title: "old B", last_activity_at: 1 },
			],
		});
	});

	it('is a no-op when the `["threads"]` cache is empty (no row synthesized)', () => {
		// No `["threads"]` data seeded: the `old && …` guard returns undefined, so
		// React Query bails out and never materializes a cache entry.
		const qc = new QueryClient();

		expect(() =>
			applyThreadTitled(qc, { thread_id: "t1", title: "x" }),
		).not.toThrow();

		expect(qc.getQueryData<ThreadListResult>(["threads"])).toBeUndefined();
	});

	/**
	 * Capture the closure `registerThreadTitledHandler` registers under
	 * "thread/titled" by spying the SDK seam, so a test can drive raw (unknown)
	 * `params` through the REAL decode→applyThreadTitled glue — the load-bearing
	 * wiring the feature ships on. A gutted/no-op registration leaves `registered`
	 * undefined (or never patches), failing these tests where a `.not.toThrow()`
	 * matcher would not.
	 */
	function captureRegisteredHandler(
		qc: QueryClient,
	): (params: unknown) => void {
		let registered: ((params: unknown) => void) | undefined;
		const spy = vi
			.spyOn(sdk, "setNotificationHandler")
			.mockImplementation((method, handler) => {
				if (method === "thread/titled") {
					registered = handler;
				}
			});
		registerThreadTitledHandler(qc);
		spy.mockRestore();
		if (registered === undefined) {
			throw new Error(
				'registerThreadTitledHandler did not register a "thread/titled" handler',
			);
		}
		return registered;
	}

	it("wires the SDK seam so a valid thread/titled frame re-titles the cached row", () => {
		const qc = seedThreads();
		const handler = captureRegisteredHandler(qc);

		// Drive a raw `unknown` params object through the real registered closure
		// (decode → applyThreadTitled), exactly as the SDK's onFrame would.
		handler({ thread_id: "t1", title: "new A" });

		expect(qc.getQueryData<ThreadListResult>(["threads"])).toEqual({
			threads: [
				{ id: "t1", title: "new A", last_activity_at: 2 },
				{ id: "t2", title: "old B", last_activity_at: 1 },
			],
		});
	});

	it("ignores a malformed thread/titled frame — no throw, cache untouched", () => {
		const qc = seedThreads();
		const handler = captureRegisteredHandler(qc);

		// Missing `title` → the schema decode fails; the Either.isLeft guard must
		// early-return so the bad frame neither throws nor mutates the cache.
		expect(() => handler({ thread_id: "t1" })).not.toThrow();
		expect(() => handler({ nonsense: true })).not.toThrow();

		expect(qc.getQueryData<ThreadListResult>(["threads"])).toEqual({
			threads: [
				{ id: "t1", title: "old A", last_activity_at: 2 },
				{ id: "t2", title: "old B", last_activity_at: 1 },
			],
		});
	});

	it("registers via the SDK seam and its disposer clears without throwing", () => {
		const qc = new QueryClient();
		const dispose = registerThreadTitledHandler(qc);
		expect(() => dispose()).not.toThrow();
	});
});
