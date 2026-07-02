import type { RunRetryResult } from "@inkstone/protocol";
import {
	type RunEventValue,
	type RunId,
	stubWsClient,
	WsClient,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitRun, hasRunFiber, resetBridge, retryRun } from "./bridge.js";
import {
	appendUserMessage,
	concatText,
	getChatState,
	getRun,
	resetChatStore,
	resetMessageForRetry,
	seedAssistantMessage,
} from "./chat.js";

// Slice 2 of run/retry (ADR-0028 retry amendment, #230): the Web Retry button
// re-drives the SAME errored Run in place — it MUST NOT seed a second user/
// assistant turn (the #230 bug today's seedTurn re-send produces).

/**
 * Stub WsClient whose `retryRun` is spied + scripted, and whose `subscribeRun`
 * yields a caller-controlled queue (mirrors run-record.test.tsx). `retryRun`
 * records the run id it was called with so the test can assert the wiring.
 */
function makeStubRuntime(
	queue: Queue.Queue<RunEventValue>,
	retryOutcome: RunRetryResult["outcome"],
) {
	const retrySpy = vi.fn((_runId: RunId) =>
		Effect.succeed({ outcome: retryOutcome }),
	);
	const stub = stubWsClient({
		subscribeRun: () => Stream.fromQueue(queue),
		retryRun: retrySpy,
	});
	return {
		runtime: ManagedRuntime.make(Layer.succeed(WsClient, stub)),
		retrySpy,
	};
}

/** Seed a thread with one completed user message + one errored assistant message
 * bound to `runId` (the errored bubble): status `incomplete` + an `error` set. */
function seedErroredTurn(runId: RunId): void {
	appendUserMessage("t1", {
		id: "u1",
		role: "user",
		status: "completed",
		segments: [{ kind: "text", text: "do it" }],
		run_id: "",
	});
	seedAssistantMessage("t1", {
		id: "a1",
		role: "assistant",
		status: "incomplete",
		segments: [{ kind: "text", text: "half " }],
		error: "the model fell over",
		run_id: runId,
	});
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

describe("resetMessageForRetry — flips an errored bubble back to streaming", () => {
	it("incomplete + error → streaming, error cleared", () => {
		appendUserMessage("t1", {
			id: "u1",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "do it" }],
			run_id: "",
		});
		seedAssistantMessage("t1", {
			id: "a1",
			role: "assistant",
			status: "incomplete",
			segments: [{ kind: "text", text: "half " }],
			error: "boom",
			run_id: "run-1",
		});

		resetMessageForRetry("t1", "run-1");

		const msg = getChatState().threads.t1?.messages.find((m) => m.id === "a1");
		expect(msg?.status).toBe("streaming");
		expect(msg?.error).toBeUndefined();
		// Segments are cleared so the cumulative-SET snapshot lands on a clean
		// timeline (the failed attempt's text/tool/proposal artifacts are discarded).
		expect(msg?.segments).toEqual([]);
	});

	it("clears NON-text segments too (tool_call / proposal artifacts), not just text", () => {
		// The segment-clear is the ONLY web-side discard of a failed attempt's
		// tool_call/proposal segments — the cumulative-text SET only replaces TEXT
		// segments, so a reset that filtered to text (instead of clearing all) would
		// leak the failed attempt's tool/proposal rows into the re-driven timeline.
		appendUserMessage("t1", {
			id: "u1",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "do it" }],
			run_id: "",
		});
		seedAssistantMessage("t1", {
			id: "a1",
			role: "assistant",
			status: "incomplete",
			segments: [
				{
					kind: "tool_call",
					call: { id: "tc1", name: "search", status: "error" },
				},
				{ kind: "text", text: "half " },
				{ kind: "proposal", runId: "run-1" },
			],
			error: "boom",
			run_id: "run-1",
		});

		resetMessageForRetry("t1", "run-1");

		const msg = getChatState().threads.t1?.messages.find((m) => m.id === "a1");
		expect(msg?.status).toBe("streaming");
		// EVERY segment is gone — text, tool_call, AND proposal.
		expect(msg?.segments).toEqual([]);
	});

	it("also clears a `cancelled` flag if one was set", () => {
		appendUserMessage("t1", {
			id: "u1",
			role: "user",
			status: "completed",
			segments: [{ kind: "text", text: "do it" }],
			run_id: "",
		});
		seedAssistantMessage("t1", {
			id: "a1",
			role: "assistant",
			status: "incomplete",
			segments: [],
			cancelled: true,
			run_id: "run-1",
		});

		resetMessageForRetry("t1", "run-1");

		const msg = getChatState().threads.t1?.messages.find((m) => m.id === "a1");
		expect(msg?.status).toBe("streaming");
		expect(msg?.cancelled).toBeUndefined();
	});
});

describe("retryRun bridge — re-drives the SAME Run, no seeded turn", () => {
	it("onRetry_re_drives_same_run_without_seeding_a_turn", async () => {
		const runId = "run-err" as RunId;
		seedErroredTurn(runId);

		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const { runtime, retrySpy } = makeStubRuntime(queue, "accepted");

		await retryRun(runtime, "t1", runId);

		// (a) the SDK retryRun was called with exactly this run id.
		expect(retrySpy).toHaveBeenCalledTimes(1);
		expect(retrySpy).toHaveBeenCalledWith(runId);

		// (b) the thread STILL has exactly one user + one assistant message (no
		// seedTurn duplication — the #230 bug).
		const msgs = () => getChatState().threads.t1?.messages ?? [];
		expect(msgs().filter((m) => m.role === "user")).toHaveLength(1);
		expect(msgs().filter((m) => m.role === "assistant")).toHaveLength(1);

		// (c) the existing assistant message reset to `streaming`, error cleared.
		const assistant = () => msgs().find((m) => m.role === "assistant");
		expect(assistant()?.id).toBe("a1"); // same message id throughout
		expect(assistant()?.status).toBe("streaming");
		expect(assistant()?.error).toBeUndefined();
		// The same run record is re-armed for the cumulative snapshot.
		expect(getRun(runId)?.status).toBe("running");
		expect(getRun(runId)?.snapshotArmed).toBe(true);

		// (d) after a text_delta then done on the queue, the assistant shows the NEW
		// text only (the stale "half " is replaced by the cumulative snapshot) and
		// settles `completed` — same message id throughout.
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "full answer" });
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, runId);

		expect(assistant()?.id).toBe("a1");
		expect(assistant()?.status).toBe("completed");
		expect(concatText(assistant()?.segments ?? [])).toBe("full answer");

		await runtime.dispose();
	});

	it("a not_errored outcome is a benign no-op (no re-subscribe, bubble unchanged)", async () => {
		const runId = "run-cancelled" as RunId;
		seedErroredTurn(runId);

		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const { runtime, retrySpy } = makeStubRuntime(queue, "not_errored");

		await retryRun(runtime, "t1", runId);

		// The SDK was asked, but a non-errored Run is not re-driven: no run record
		// is armed and the bubble keeps its errored state.
		expect(retrySpy).toHaveBeenCalledWith(runId);
		expect(getRun(runId)).toBeUndefined();
		const assistant = getChatState().threads.t1?.messages.find(
			(m) => m.role === "assistant",
		);
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toBe("the model fell over");

		await runtime.dispose();
	});

	it("an unknown_run outcome is a benign no-op (bubble unchanged, no re-subscribe)", async () => {
		const runId = "run-gone" as RunId;
		seedErroredTurn(runId);

		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const { runtime, retrySpy } = makeStubRuntime(queue, "unknown_run");

		await retryRun(runtime, "t1", runId);

		// Same shape as not_errored: Core did not flip the Run, so nothing is
		// re-driven — no run record armed, the bubble keeps its errored state.
		expect(retrySpy).toHaveBeenCalledWith(runId);
		expect(getRun(runId)).toBeUndefined();
		expect(hasRunFiber(runId)).toBe(false);
		const assistant = getChatState().threads.t1?.messages.find(
			(m) => m.role === "assistant",
		);
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toBe("the model fell over");

		await runtime.dispose();
	});

	it("propagates a failed retry REQUEST as { ok: false } so the caller can show connection copy", async () => {
		// A transport/decode failure of run/retry itself (NOT a not_errored/unknown_run
		// outcome) must surface to the caller — else the retry button is a silent no-op
		// (CodeRabbit #244). The bubble is left as-is; the caller renders the failure.
		const runId = "run-down" as RunId;
		seedErroredTurn(runId);

		const stub = stubWsClient({
			retryRun: () =>
				Effect.fail(new WsRequestError({ reason: "connection_lost" })),
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));

		const result = await retryRun(runtime, "t1", runId);

		// The request failed → { ok: false } carrying the real WsError (its `reason`
		// drives ChatColumn's connection-specific copy, mirroring a failed send).
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect((result.error as WsRequestError).reason).toBe("connection_lost");
		}
		// Nothing was re-driven: no run record armed, no fiber, bubble unchanged.
		expect(getRun(runId)).toBeUndefined();
		expect(hasRunFiber(runId)).toBe(false);
		const assistant = getChatState().threads.t1?.messages.find(
			(m) => m.role === "assistant",
		);
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toBe("the model fell over");

		await runtime.dispose();
	});
});

/**
 * Stub WsClient that hands out a FRESH queue per `subscribeRun` call (the `queues`
 * list is consumed in order), so a test can drive the first vs the second retry's
 * subscription independently — the seam that proves a re-retry interrupted the
 * prior stream fiber rather than leaving two fibers on the same runId.
 */
function makePerCallStubRuntime(queues: Queue.Queue<RunEventValue>[]) {
	let call = 0;
	const stub = stubWsClient({
		subscribeRun: () => Stream.fromQueue(queues[call++]),
		retryRun: () => Effect.succeed({ outcome: "accepted" as const }),
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

describe("retryRun bridge — a re-retry interrupts the prior stream fiber (M2)", () => {
	it("a second retry interrupts the first fiber so only the second drives the bubble", async () => {
		const runId = "run-err" as RunId;
		seedErroredTurn(runId);

		// Two queues: queue[0] feeds the first retry's fiber, queue[1] the second's.
		const queue0 = Effect.runSync(Queue.unbounded<RunEventValue>());
		const queue1 = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makePerCallStubRuntime([queue0, queue1]);

		// First retry forks fiber A (subscribed to queue0).
		await retryRun(runtime, "t1", runId);
		expect(hasRunFiber(runId)).toBe(true);

		// Second retry: interrupt-then-resubscribe forks fiber B (subscribed to
		// queue1). Without the `interruptRun` line, fiber A would survive on queue0.
		await retryRun(runtime, "t1", runId);
		expect(hasRunFiber(runId)).toBe(true);

		const assistant = () =>
			getChatState().threads.t1?.messages.find((m) => m.role === "assistant");

		// Drive a terminal on the FIRST fiber's queue. If fiber A was interrupted
		// (the fix), nothing consumes queue0 and the bubble stays `streaming`. If it
		// leaked (the bug), fiber A would consume this and settle the bubble.
		Queue.unsafeOffer(queue0, { kind: "text_delta", delta: "STALE" });
		Queue.unsafeOffer(queue0, { kind: "done" });
		await new Promise((r) => setTimeout(r, 0));
		expect(assistant()?.status).toBe("streaming");
		expect(concatText(assistant()?.segments ?? [])).toBe("");

		// The SECOND fiber owns the bubble: its events drive it to completion.
		Queue.unsafeOffer(queue1, { kind: "text_delta", delta: "fresh answer" });
		Queue.unsafeOffer(queue1, { kind: "done" });
		await awaitRun(runtime, runId);
		expect(assistant()?.status).toBe("completed");
		expect(concatText(assistant()?.segments ?? [])).toBe("fresh answer");

		await runtime.dispose();
	});
});
