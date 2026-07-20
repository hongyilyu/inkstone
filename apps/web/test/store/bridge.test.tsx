import {
	type ThreadListResult,
	ThreadTitledNotification,
} from "@inkstone/protocol";
import {
	onNotification,
	type RunEventValue,
	type RunId,
	type WsClientService,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import type { QueryClient } from "@tanstack/react-query";
import {
	makeCoreRuntime,
	makeQueryClient,
} from "@test/test-utils/renderWithCore";
import { Deferred, Effect, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WsRuntime } from "@/runtime.js";
import {
	applyThreadTitled,
	cancelRun as cancelRunBridge,
	decideProposal,
	hasRunFiber,
	interruptRun,
	registerThreadTitledHandler,
	resetBridge,
	send,
	sendNewThread,
	setOnRunSettled,
	startRunStream,
} from "@/store/bridge.js";
import {
	appendMessage,
	attachRun,
	getChatState,
	resetChatStore,
	setPendingProposal,
	setProposalStatus,
} from "@/store/chat.js";

// Stub WsClient whose threadCreate fails; only that runs on the sendNewThread path.
function makeFailingThreadCreateRuntime() {
	return makeCoreRuntime({
		overrides: {
			threadCreate: () => Effect.fail(new WsRequestError({ reason: "boom" })),
		},
	});
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

describe("send path with image attachments (upload-then-post, ADR-0058)", () => {
	// base64("ABC") = "QUJD", base64("DEF") = "REVG" — tiny deterministic payloads.
	const filePng = () => new File(["ABC"], "a.png", { type: "image/png" });
	const fileJpg = () => new File(["DEF"], "b.jpg", { type: "image/jpeg" });

	/** Stub runtime capturing mediaUpload/postMessage/threadCreate calls; uploads mint m1, m2, … */
	function makeUploadRuntime() {
		let n = 0;
		const mediaUpload = vi.fn(
			(
				_bytesBase64: string,
				_mime: string,
				_width?: number,
				_height?: number,
			) => {
				n += 1;
				return Effect.succeed({ media_id: `m${n}` });
			},
		);
		const postMessage = vi.fn(
			(
				_threadId: string,
				_prompt: string,
				_attachmentIds?: readonly string[],
			) => Effect.succeed("r-1" as RunId),
		);
		const threadCreate = vi.fn(
			(_prompt: string, _attachmentIds?: readonly string[]) =>
				Effect.succeed({ thread_id: "t-new", run_id: "r-1" }),
		);
		return {
			runtime: makeCoreRuntime({
				overrides: { mediaUpload, postMessage, threadCreate },
			}),
			mediaUpload,
			postMessage,
			threadCreate,
		};
	}

	it("send(files): uploads each file, posts with the minted attachment_ids, and seeds the user bubble with attachment segments", async () => {
		const { runtime, mediaUpload, postMessage } = makeUploadRuntime();

		const result = await send(runtime, "t1", "hi", [filePng(), fileJpg()]);

		expect(result).toEqual({ ok: true });
		// Each file was uploaded as RAW base64 (no data: prefix) with its own mime.
		expect(mediaUpload).toHaveBeenCalledTimes(2);
		expect(mediaUpload.mock.calls[0]?.[0]).toBe("QUJD");
		expect(mediaUpload.mock.calls[0]?.[1]).toBe("image/png");
		expect(mediaUpload.mock.calls[1]?.[0]).toBe("REVG");
		expect(mediaUpload.mock.calls[1]?.[1]).toBe("image/jpeg");
		// The post carries the minted ids, in file order.
		expect(postMessage).toHaveBeenCalledWith("t1", "hi", ["m1", "m2"]);
		// The optimistic user bubble seeds text + one attachment segment per file,
		// so the images render instantly (the ids exist pre-post; /media/{id} resolves).
		const user = getChatState().threads.t1?.messages.find(
			(m) => m.role === "user",
		);
		expect(user?.segments).toEqual([
			{ kind: "text", text: "hi" },
			{ kind: "attachment", mediaId: "m1", mime: "image/png" },
			{ kind: "attachment", mediaId: "m2", mime: "image/jpeg" },
		]);

		await runtime.dispose();
	});

	it("send without files keeps the plain two-arg post (no attachment_ids on the wire)", async () => {
		const { runtime, mediaUpload, postMessage } = makeUploadRuntime();

		const result = await send(runtime, "t1", "hi");

		expect(result).toEqual({ ok: true });
		expect(mediaUpload).not.toHaveBeenCalled();
		// EXACTLY two args — a trailing undefined/[] would fail this matcher.
		expect(postMessage).toHaveBeenCalledWith("t1", "hi");

		await runtime.dispose();
	});

	it("a failed upload short-circuits: { ok: false }, no post, nothing seeded", async () => {
		const mediaUpload = vi.fn(() =>
			Effect.fail(new WsRequestError({ reason: "too_large", code: -32602 })),
		);
		const postMessage = vi.fn(() => Effect.succeed("r-1" as RunId));
		const runtime = makeCoreRuntime({
			overrides: { mediaUpload, postMessage },
		});

		const result = await send(runtime, "t1", "hi", [filePng()]);

		expect(result).toEqual({ ok: false, error: expect.anything() });
		expect(postMessage).not.toHaveBeenCalled();
		// Short-circuit BEFORE the optimistic seed: no orphaned bubble to clean up.
		expect(Object.keys(getChatState().threads)).toHaveLength(0);

		await runtime.dispose();
	});

	it("sendNewThread(files): uploads, creates with attachment_ids, and seeds the minted thread with attachment segments", async () => {
		const { runtime, threadCreate } = makeUploadRuntime();

		const result = await sendNewThread(runtime, "hi", [filePng()]);

		expect(result).toEqual({ ok: true, threadId: "t-new" });
		expect(threadCreate).toHaveBeenCalledWith("hi", ["m1"]);
		const user = getChatState().threads["t-new"]?.messages.find(
			(m) => m.role === "user",
		);
		expect(user?.segments).toEqual([
			{ kind: "text", text: "hi" },
			{ kind: "attachment", mediaId: "m1", mime: "image/png" },
		]);

		await runtime.dispose();
	});

	it("sendNewThread: a failed upload short-circuits before thread/create (no thread minted)", async () => {
		const mediaUpload = vi.fn(() =>
			Effect.fail(new WsRequestError({ reason: "too_large", code: -32602 })),
		);
		const threadCreate = vi.fn(() =>
			Effect.succeed({ thread_id: "t-new", run_id: "r-1" }),
		);
		const runtime = makeCoreRuntime({
			overrides: { mediaUpload, threadCreate },
		});

		const result = await sendNewThread(runtime, "hi", [filePng()]);

		expect(result).toEqual({ ok: false, error: expect.anything() });
		expect(threadCreate).not.toHaveBeenCalled();
		expect(Object.keys(getChatState().threads)).toHaveLength(0);

		await runtime.dispose();
	});
});

describe("onRunSettled (terminal seam → recent-Runs refresh)", () => {
	/** A stub whose subscribeRun replays a fixed event sequence then closes. */
	function makeRuntime(events: RunEventValue[]) {
		return makeCoreRuntime({
			overrides: {
				subscribeRun: () => Stream.fromIterable<RunEventValue>(events),
			},
		});
	}

	function seed(runId: RunId) {
		appendMessage("t1", {
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
		const runtime = makeCoreRuntime({
			overrides: {
				subscribeRun: (): Stream.Stream<RunEventValue, WsError> =>
					Stream.fromIterable<RunEventValue>([
						{ kind: "text_delta", delta: "partial" },
					]).pipe(
						Stream.concat(
							Stream.fail(new WsRequestError({ reason: "socket closed" })),
						),
					),
			},
		});
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
		const runtime = makeCoreRuntime({
			overrides: {
				subscribeRun: (): Stream.Stream<RunEventValue, WsError> =>
					Stream.fromQueue(Effect.runSync(Queue.unbounded<RunEventValue>())),
			},
		});
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
		const runtime = makeCoreRuntime({
			overrides: {
				subscribeRun,
				proposalDecide: () =>
					Effect.succeed({ status: "accepted" as const, entity_id: "e1" }),
			},
		});

		// Seed a parked run + its original (parked) subscribe fiber + a proposal.
		const runId = "run-resume" as RunId;
		appendMessage("t1", {
			id: "u1",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "hi" }],
			run_id: runId,
		});
		appendMessage("t1", {
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
		return {
			runtime: makeCoreRuntime({ overrides: { subscribeRun, cancelRun } }),
			cancelRun,
		};
	}

	/** Seed a streaming-or-parked assistant turn whose Run is being watched. */
	function seedActiveRun(runId: RunId, runtime: WsRuntime) {
		appendMessage("t1", {
			id: "u1",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "hi" }],
			run_id: "",
		});
		appendMessage("t1", {
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
		const runtime = makeCoreRuntime({
			overrides: {
				subscribeRun,
				cancelRun: () => Effect.fail(new WsRequestError({ reason: "boom" })),
				retryRun: () => Effect.fail(new WsRequestError({ reason: "boom" })),
			},
		});
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
		const runtime = makeCoreRuntime({
			overrides: {
				subscribeRun,
				cancelRun: () => Effect.succeed({ outcome: "accepted" as const }),
				retryRun: () => Effect.succeed({ outcome: "accepted" as const }),
				proposalDecide: () =>
					Effect.promise(() => decideGate).pipe(
						Effect.as({ status: "accepted" as const, entity_id: "e1" }),
					),
			},
		});
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
		const qc = makeQueryClient();
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
		const qc = makeQueryClient();

		expect(() =>
			applyThreadTitled(qc, { thread_id: "t1", title: "x" }),
		).not.toThrow();

		expect(qc.getQueryData<ThreadListResult>(["threads"])).toBeUndefined();
	});

	it("wires the SDK notifications stream so a pushed thread/titled frame re-titles the cached row", async () => {
		const qc = seedThreads();
		// Drive the channel end-to-end through the real onNotification wiring: a
		// test-owned queue feeds the stubbed `notifications` stream, so offering a
		// decoded frame exercises registerThreadTitledHandler → onNotification →
		// applyThreadTitled exactly as the live SDK's PubSub would (the SDK owns the
		// raw-frame decode now; the ui-sdk wire suite covers decode-drop).
		const titled = Effect.runSync(
			Queue.unbounded<{ thread_id: string; title: string }>(),
		);
		// Capture the (method, schema) the bridge subscribes with, so wrong wiring
		// (subscribing the wrong method, or dropping the schema) fails this test rather
		// than passing on a method-blind stub. The stub bypasses the SDK's schema
		// decode — the test offers an already-decoded value — hence the cast.
		let subscribedMethod: string | undefined;
		let subscribedSchema: unknown;
		const runtime = makeCoreRuntime({
			overrides: {
				notifications: ((method: string, schema: unknown) => {
					subscribedMethod = method;
					subscribedSchema = schema;
					return Stream.fromQueue(titled);
				}) as WsClientService["notifications"],
			},
		});

		const dispose = registerThreadTitledHandler(runtime, qc);
		Effect.runSync(Queue.offer(titled, { thread_id: "t1", title: "new A" }));

		await vi.waitFor(() =>
			expect(qc.getQueryData<ThreadListResult>(["threads"])).toEqual({
				threads: [
					{ id: "t1", title: "new A", last_activity_at: 2 },
					{ id: "t2", title: "old B", last_activity_at: 1 },
				],
			}),
		);
		// The bridge must subscribe the "thread/titled" method with the protocol schema.
		expect(subscribedMethod).toBe("thread/titled");
		expect(subscribedSchema).toBe(ThreadTitledNotification);
		dispose();
	});

	it("its disposer stops delivery — a frame pushed after dispose does not patch the cache", async () => {
		const qc = seedThreads();
		// A live queue-backed subscription with a FINALIZER: a frame pushed BEFORE
		// dispose patches the cache; a frame pushed AFTER dispose must NOT — proving the
		// disposer actually interrupts the subscription fiber, not a vacuous no-op (a
		// Stream.empty stub could never distinguish a real disposer from a no-op one).
		// Teardown is synchronized on a Deferred the stream's finalizer completes —
		// deterministic, not a fixed sleep (which could miss a delayed delivery).
		const titled = Effect.runSync(
			Queue.unbounded<{ thread_id: string; title: string }>(),
		);
		const tornDown = Effect.runSync(Deferred.make<void>());
		const runtime = makeCoreRuntime({
			overrides: {
				notifications: (() =>
					Stream.fromQueue(titled).pipe(
						Stream.ensuring(Deferred.succeed(tornDown, undefined)),
					)) as WsClientService["notifications"],
			},
		});

		const dispose = registerThreadTitledHandler(runtime, qc);
		Effect.runSync(Queue.offer(titled, { thread_id: "t1", title: "before" }));
		await vi.waitFor(() =>
			expect(
				qc
					.getQueryData<ThreadListResult>(["threads"])
					?.threads.find((t) => t.id === "t1")?.title,
			).toBe("before"),
		);

		// Dispose, then await the subscription's finalizer — deterministic proof the
		// fiber was interrupted — before pushing the post-dispose frame. Because the
		// subscription is provably gone, the offer below has no consumer; a brief
		// macrotask flush lets any (buggy) resurrected delivery surface before we assert.
		dispose();
		await runtime.runPromise(Deferred.await(tornDown));
		Effect.runSync(
			Queue.offer(titled, { thread_id: "t1", title: "after-dispose" }),
		);
		await new Promise((r) => setTimeout(r, 0));

		// The post-dispose frame must never reach applyThreadTitled: the title stays "before".
		expect(
			qc
				.getQueryData<ThreadListResult>(["threads"])
				?.threads.find((t) => t.id === "t1")?.title,
		).toBe("before");
	});

	it("a throwing onValue is contained per-frame — a later notification still patches the cache", async () => {
		// Guards the onNotification try/catch (round-1 fix): if the callback throws on
		// one frame, the subscription must keep running and apply the NEXT frame. Without
		// per-frame containment the first throw fails the fiber and the second frame is lost.
		const qc = seedThreads();
		const titled = Effect.runSync(
			Queue.unbounded<{ thread_id: string; title: string }>(),
		);
		const runtime = makeCoreRuntime({
			overrides: {
				notifications: (() =>
					Stream.fromQueue(titled)) as WsClientService["notifications"],
			},
		});

		// Register a handler that THROWS on the first thread_id, then delegates to the
		// real cache patch — so frame 1 throws inside onValue, frame 2 must still land.
		let seen = 0;
		const dispose = onNotification(
			runtime,
			"thread/titled",
			ThreadTitledNotification,
			(n) => {
				seen += 1;
				if (seen === 1) throw new Error("boom on first frame");
				applyThreadTitled(qc, n);
			},
		);

		Effect.runSync(Queue.offer(titled, { thread_id: "t1", title: "boom" }));
		Effect.runSync(Queue.offer(titled, { thread_id: "t1", title: "survived" }));

		// The second frame patched the cache → the subscription survived the first throw.
		await vi.waitFor(() =>
			expect(
				qc
					.getQueryData<ThreadListResult>(["threads"])
					?.threads.find((t) => t.id === "t1")?.title,
			).toBe("survived"),
		);
		dispose();
	});
});
