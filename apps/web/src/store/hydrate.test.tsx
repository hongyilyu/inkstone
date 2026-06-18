import type { ThreadGetResult } from "@inkstone/protocol";
import {
	InvalidParamsError,
	type RunEventValue,
	type RunId,
	UnknownThreadError,
	WsClient,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
import { Deferred, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitRun, resetBridge } from "./bridge.js";
import {
	appendUserMessage,
	attachRun,
	getChatState,
	getHydrationStatus,
	resetChatStore,
	seedAssistantMessage,
} from "./chat.js";
import { hydrateThread } from "./hydrate.js";

beforeEach(() => {
	resetChatStore();
	resetBridge();
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
				{
					id: "m1",
					role: "user",
					status: "completed",
					run_id: "r1",
					text: "hi",
					tool_calls: [],
				},
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "r1",
					text: "echo: hi",
					tool_calls: [],
				},
			],
		};
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: (id) =>
				id === "tA" ? Effect.succeed(result) : Effect.die("unknown thread"),
			subscribeRun,
			cancelRun: () => Effect.die("unused"),
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

	it("rehydrates tool-activity rows: maps status (error vs completed), carries arg, distinct ids", async () => {
		const subscribeRun = vi.fn(
			(_runId: RunId): Stream.Stream<RunEventValue, WsError> => Stream.empty,
		);
		const result: ThreadGetResult = {
			thread_id: "tTools",
			title: "T",
			messages: [
				{
					id: "m1",
					role: "user",
					status: "completed",
					run_id: "r1",
					text: "find people",
					tool_calls: [],
				},
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "r1",
					text: "done",
					tool_calls: [
						{ name: "search_entities", status: "completed", arg: "Lev" },
						{ name: "search_entities", status: "error", arg: "Acme" },
					],
				},
			],
		};
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: (id) =>
				id === "tTools" ? Effect.succeed(result) : Effect.die("unknown thread"),
			subscribeRun,
			cancelRun: () => Effect.die("unused"),
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

		await hydrateThread(runtime, "tTools");

		const assistant = getChatState().threads.tTools?.messages[1];
		expect(assistant?.toolCalls).toEqual([
			{
				id: "m2:tc:0",
				name: "search_entities",
				status: "completed",
				arg: "Lev",
			},
			{ id: "m2:tc:1", name: "search_entities", status: "error", arg: "Acme" },
		]);

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
					tool_calls: [],
				},
				{
					id: "m2",
					role: "assistant",
					status: "streaming",
					run_id: "r2",
					text: "echo: ",
					tool_calls: [],
				},
			],
		};
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: (id) =>
				id === "tB" ? Effect.succeed(result) : Effect.die("unknown thread"),
			subscribeRun,
			cancelRun: () => Effect.die("unused"),
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

		await hydrateThread(runtime, "tB");

		// activeRunId set; no Run record yet, so the resubscribe arms the snapshot and its first delta SETs.
		const hydrated = getChatState().threads.tB;
		expect(hydrated?.messages.map((m) => [m.role, m.text, m.status])).toEqual([
			["user", "hello", "completed"],
			["assistant", "echo: ", "streaming"],
		]);
		expect(hydrated?.activeRunId).toBe("r2");

		// The resubscribe's first text_delta is the cumulative snapshot (SET), then done finalizes.
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "echo: hello" });
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "r2");

		expect(subscribeRun).toHaveBeenCalledWith("r2");
		const resumed = getChatState().threads.tB;
		const assistant = resumed?.messages[1];
		expect(assistant?.text).toBe("echo: hello");
		expect(assistant?.status).toBe("completed");
		expect(resumed?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("preserves a turn sent during the in-flight thread/get and folds in history", async () => {
		// threadGet parks on the latch, modeling the live-composer-under-skeleton window.
		const gate = Effect.runSync(Deferred.make<ThreadGetResult, WsError>());
		const subscribeRun = vi.fn(
			(_runId: RunId): Stream.Stream<RunEventValue, WsError> => Stream.empty,
		);
		const history: ThreadGetResult = {
			thread_id: "tC",
			title: "T",
			messages: [
				{
					id: "s1",
					role: "user",
					status: "completed",
					run_id: "old",
					text: "earlier",
					tool_calls: [],
				},
				{
					id: "s2",
					role: "assistant",
					status: "completed",
					run_id: "old",
					text: "earlier reply",
					tool_calls: [],
				},
			],
		};
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: (id) =>
				id === "tC" ? Deferred.await(gate) : Effect.die("unknown thread"),
			subscribeRun,
			cancelRun: () => Effect.die("unused"),
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

		// Start hydration; threadGet is parked on the latch.
		const hydrating = hydrateThread(runtime, "tC");

		// A send lands during the window: seed the optimistic turn + attach a run.
		appendUserMessage("tC", {
			id: "u1",
			role: "user",
			status: "completed",
			text: "live message",
			run_id: "",
		});
		seedAssistantMessage("tC", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "",
		});
		attachRun("tC", "a1", "live-run");

		// Now let threadGet resolve with the (stale) server history.
		Effect.runSync(Deferred.succeed(gate, history));
		await hydrating;

		// The seeded live turn survives; fetched history is folded in front (older first).
		const thread = getChatState().threads.tC;
		expect(thread?.messages.map((m) => m.text)).toEqual([
			"earlier",
			"earlier reply",
			"live message",
			"",
		]);
		// The live turn keeps the active run; history did not steal it.
		expect(thread?.activeRunId).toBe("live-run");
		// And the settled history run was NOT resubscribed.
		expect(subscribeRun).not.toHaveBeenCalled();

		await runtime.dispose();
	});

	it("settles `ready` (not `error`) when thread/get FAILS but a send made the thread live mid-fetch", async () => {
		// Contrast to the became-live success case: here thread/get REJECTS after the user sent.
		// A failed fetch must not paint a recoverable-error screen over the valid live turn — it settles `ready`.
		const gate = Effect.runSync(Deferred.make<ThreadGetResult, WsError>());
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: (id) =>
				id === "tD" ? Deferred.await(gate) : Effect.die("unknown thread"),
			subscribeRun: () => Stream.empty,
			cancelRun: () => Effect.die("unused"),
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

		// Start hydration; threadGet is parked on the latch.
		const hydrating = hydrateThread(runtime, "tD");

		// A send lands during the window: seed the optimistic turn + attach a run.
		appendUserMessage("tD", {
			id: "u1",
			role: "user",
			status: "completed",
			text: "live message",
			run_id: "",
		});
		seedAssistantMessage("tD", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "",
		});
		attachRun("tD", "a1", "live-run");

		// Now let threadGet FAIL.
		Effect.runSync(Deferred.fail(gate, new WsRequestError({ reason: "boom" })));
		await hydrating;

		// The became-live arm of the failure callback wins: status is `ready`, not `error`.
		expect(getHydrationStatus("tD")).toBe("ready");
		// The live turn survives intact — no error screen painted over valid content.
		const thread = getChatState().threads.tD;
		expect(thread?.messages.map((m) => m.text)).toEqual(["live message", ""]);
		expect(thread?.activeRunId).toBe("live-run");

		await runtime.dispose();
	});

	it("marks a missing thread (`UnknownThreadError`) as `not_found`, not `error`", async () => {
		// A genuinely missing Thread (Core `-32001`) is a deterministic dead-end:
		// it must end in `not_found` so the UI shows an honest "isn't available"
		// state with a Back-to-New-Chat exit, never a retry that can't succeed.
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: () =>
				Effect.fail(new UnknownThreadError({ message: "no such thread" })),
			subscribeRun: () => Stream.empty,
			cancelRun: () => Effect.die("unused"),
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

		await hydrateThread(runtime, "tGhost");

		expect(getHydrationStatus("tGhost")).toBe("not_found");
		expect(getChatState().threads.tGhost?.messages ?? []).toHaveLength(0);

		await runtime.dispose();
	});

	it("marks a malformed thread id (`InvalidParamsError`) as `not_found`, not the retryable `error`", async () => {
		// A non-UUID thread id in the URL (a typo'd/truncated shared link) fails
		// Core's uuid decode → -32602 → InvalidParamsError. It's as deterministic a
		// dead-end as an unknown thread — retrying re-fails identically — so it must
		// land on not_found, NOT the recoverable retry path (deep-review finding).
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: () =>
				Effect.fail(
					new InvalidParamsError({ message: "thread_id must be a UUID" }),
				),
			subscribeRun: () => Stream.empty,
			cancelRun: () => Effect.die("unused"),
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

		await hydrateThread(runtime, "not-a-uuid");

		expect(getHydrationStatus("not-a-uuid")).toBe("not_found");

		await runtime.dispose();
	});

	it("keeps a became-live turn (`ready`) even when thread/get reports the thread missing", async () => {
		// A send can turn a "missing" Thread live (the optimistic seed) before the
		// UnknownThreadError lands — keep that live turn rather than blanking it.
		const gate = Effect.runSync(Deferred.make<ThreadGetResult, WsError>());
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: (id) =>
				id === "tRace" ? Deferred.await(gate) : Effect.die("unknown thread"),
			subscribeRun: () => Stream.empty,
			cancelRun: () => Effect.die("unused"),
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

		const hydrating = hydrateThread(runtime, "tRace");
		appendUserMessage("tRace", {
			id: "u1",
			role: "user",
			status: "completed",
			text: "live message",
			run_id: "",
		});
		attachRun("tRace", "u1", "live-run");

		Effect.runSync(
			Deferred.fail(
				gate,
				new UnknownThreadError({ message: "no such thread" }),
			),
		);
		await hydrating;

		expect(getHydrationStatus("tRace")).toBe("ready");
		expect(getChatState().threads.tRace?.messages.map((m) => m.text)).toEqual([
			"live message",
		]);

		await runtime.dispose();
	});

	it("marks a failed thread/get as `error` (recoverable, not an eternal skeleton)", async () => {
		// A wire failure: thread/get rejects. The thread must end in `error` status — never stuck `loading`.
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: () => Effect.fail(new WsRequestError({ reason: "boom" })),
			subscribeRun: () => Stream.empty,
			cancelRun: () => Effect.die("unused"),
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

		await hydrateThread(runtime, "tFail");

		expect(getHydrationStatus("tFail")).toBe("error");
		expect(getChatState().threads.tFail?.messages ?? []).toHaveLength(0);

		// A user-driven retry that succeeds clears the error and loads history.
		const ok: ThreadGetResult = {
			thread_id: "tFail",
			title: "T",
			messages: [
				{
					id: "m1",
					role: "user",
					status: "completed",
					run_id: "r1",
					text: "hi",
					tool_calls: [],
				},
			],
		};
		const okStub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.die("unused"),
			threadList: () => Effect.die("unused"),
			getRunHistory: () => Effect.die("unused"),
			listEntities: () => Effect.die("unused"),
			entityMutate: () => Effect.die("unused"),
			threadGet: () => Effect.succeed(ok),
			subscribeRun: () => Stream.empty,
			cancelRun: () => Effect.die("unused"),
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
		const okRuntime = ManagedRuntime.make(Layer.succeed(WsClient, okStub));

		await hydrateThread(okRuntime, "tFail");

		expect(getHydrationStatus("tFail")).toBe("ready");
		expect(getChatState().threads.tFail?.messages.map((m) => m.text)).toEqual([
			"hi",
		]);

		await runtime.dispose();
		await okRuntime.dispose();
	});
});
