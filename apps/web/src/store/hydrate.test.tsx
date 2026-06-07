import type { ThreadGetResult } from "@inkstone/protocol";
import {
	type RunEventValue,
	type RunId,
	WsClient,
	type WsError,
} from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitRun, resetBridge } from "./bridge.js";
import { getChatState, resetChatStore } from "./chat.js";
import { hydrateThread, resetHydration } from "./hydrate.js";

beforeEach(() => {
	resetChatStore();
	resetBridge();
	resetHydration();
});

describe("refresh-durable hydration", () => {
	it("hydrates a completed thread → history renders, no resubscribe", async () => {
		const subscribeRun = vi.fn(
			(_runId: RunId): Stream.Stream<RunEventValue, WsError> => Stream.empty,
		);
		const result: ThreadGetResult = {
			thread_id: "tA",
			title: "T",
			messages: [
				{ id: "m1", role: "user", status: "completed", run_id: "r1", text: "hi" },
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "r1",
					text: "echo: hi",
				},
			],
		};
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			threadGet: (id) =>
				id === "tA" ? Effect.succeed(result) : Effect.die("unknown thread"),
			subscribeRun,
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));

		await hydrateThread(runtime, "tA");

		const thread = getChatState().threads.tA;
		expect(thread?.messages.map((m) => [m.role, m.text, m.status])).toEqual([
			["user", "hi", "completed"],
			["assistant", "echo: hi", "completed"],
		]);
		// No streaming message → no resubscribe.
		expect(subscribeRun).not.toHaveBeenCalled();
		expect(thread?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("hydrates a streaming thread → resubscribes by run_id and resumes the tail", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const subscribeRun = vi.fn(
			(_runId: RunId): Stream.Stream<RunEventValue, WsError> =>
				Stream.fromQueue(queue),
		);
		const result: ThreadGetResult = {
			thread_id: "tB",
			title: "T",
			messages: [
				{
					id: "m1",
					role: "user",
					status: "completed",
					run_id: "r2",
					text: "hello",
				},
				{
					id: "m2",
					role: "assistant",
					status: "streaming",
					run_id: "r2",
					text: "echo: ",
				},
			],
		};
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			threadGet: (id) =>
				id === "tB" ? Effect.succeed(result) : Effect.die("unknown thread"),
			subscribeRun,
			providerStatus: () => Effect.die("unused"),
			providerLoginStart: () => Effect.die("unused"),
			modelCatalog: () => Effect.die("unused"),
			settingsGet: () => Effect.die("unused"),
			settingsSet: () => Effect.die("unused"),
			proposalGet: () => Effect.die("unused"),
			proposalDecide: () => Effect.die("unused"),
			proposalNotifications: () => Stream.empty,
		});
		const runtime = ManagedRuntime.make(Layer.succeed(WsClient, stub));

		await hydrateThread(runtime, "tB");

		// History loaded with the streaming message's partial paint; activeRunId
		// set; snapshotApplied left unset so the resubscribe snapshot SETs.
		const hydrated = getChatState().threads.tB;
		expect(hydrated?.messages.map((m) => [m.role, m.text, m.status])).toEqual([
			["user", "hello", "completed"],
			["assistant", "echo: ", "streaming"],
		]);
		expect(hydrated?.activeRunId).toBe("r2");

		// The resubscribe's first text_delta is the cumulative snapshot (SET),
		// then done finalizes. Offer to the queue, then join the stream fiber.
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "echo: hello" });
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "r2");

		// (a) resubscribe happened by run_id; (b) the assistant message resumed +
		// finalized to the authoritative cumulative text.
		expect(subscribeRun).toHaveBeenCalledWith("r2");
		const resumed = getChatState().threads.tB;
		const assistant = resumed?.messages[1];
		expect(assistant?.text).toBe("echo: hello");
		expect(assistant?.status).toBe("completed");
		expect(resumed?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});
});
