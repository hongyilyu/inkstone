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
	concatText,
	getChatState,
	getHydrationStatus,
	resetChatStore,
	seedAssistantMessage,
	setPendingProposal,
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
					segments: [{ kind: "text", text: "hi" }],
				},
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "r1",
					segments: [{ kind: "text", text: "echo: hi" }],
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
		expect(
			thread?.messages.map((m) => [m.role, concatText(m.segments), m.status]),
		).toEqual([
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
					segments: [{ kind: "text", text: "find people" }],
				},
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "r1",
					segments: [
						{
							kind: "tool_call",
							name: "search_entities",
							status: "completed",
							arg: "Lev",
						},
						{
							kind: "tool_call",
							name: "search_entities",
							status: "error",
							arg: "Acme",
						},
						{ kind: "text", text: "done" },
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
		expect(assistant?.segments.filter((s) => s.kind === "tool_call")).toEqual([
			{
				kind: "tool_call",
				call: {
					id: "m2:seg:0",
					name: "search_entities",
					status: "completed",
					arg: "Lev",
				},
			},
			{
				kind: "tool_call",
				call: {
					id: "m2:seg:1",
					name: "search_entities",
					status: "error",
					arg: "Acme",
				},
			},
		]);

		await runtime.dispose();
	});

	it("reconstructs a decided Proposal (ADR-0044) so the settled card survives reload", async () => {
		const result: ThreadGetResult = {
			thread_id: "tProp",
			title: "T",
			messages: [
				{
					id: "m1",
					role: "user",
					status: "completed",
					run_id: "rp",
					segments: [{ kind: "text", text: "log it" }],
				},
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "rp",
					segments: [
						{ kind: "text", text: "Logged." },
						{
							kind: "proposal",
							proposal_id: "p-1",
							mutation_kind: "apply_intent_graph",
							status: "accepted",
						},
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
				id === "tProp" ? Effect.succeed(result) : Effect.die("unknown thread"),
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

		await hydrateThread(runtime, "tProp");

		// The decided outcome is reconstructed into the proposals map (keyed by run),
		// with no payload — the settled card reads only status + mutation_kind.
		expect(getChatState().proposals.rp).toEqual({
			proposal_id: "p-1",
			run_id: "rp",
			mutation_kind: "apply_intent_graph",
			payload: null,
			rationale: null,
			status: "accepted",
		});

		await runtime.dispose();
	});

	it("attaches the decided-proposal SEGMENT to the reloaded message, so the pill survives reload (ADR-0044/0045)", async () => {
		// B2 regression: the segment-only AssistantBubble (ADR-0045) renders the decided
		// card ONLY from a `proposal` segment. Rehydration must attach that segment AFTER
		// the messages are in the store (a rehydrated decided proposal has no live
		// RunRecord, so attachProposalSegment locates the message by scanning run ids —
		// which is empty until loadThreadMessages runs). Asserting only the proposals map
		// (the prior tests) missed this: the map write succeeds even with no message present.
		const result: ThreadGetResult = {
			thread_id: "tSeg",
			title: "T",
			messages: [
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "rs",
					segments: [
						{ kind: "text", text: "Logged." },
						{
							kind: "proposal",
							proposal_id: "p-seg",
							mutation_kind: "create_journal_entry",
							status: "accepted",
						},
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
				id === "tSeg" ? Effect.succeed(result) : Effect.die("unknown thread"),
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

		await hydrateThread(runtime, "tSeg");

		// The reloaded assistant message's timeline carries the proposal marker (legacy
		// order: text, then proposal — slice 3 moves it to its true run_steps slot).
		const assistant = getChatState().threads.tSeg?.messages[0];
		expect(assistant?.segments).toContainEqual({
			kind: "proposal",
			runId: "rs",
		});

		await runtime.dispose();
	});

	it("reconstructs a REJECTED decided Proposal with rejected status (ADR-0044)", async () => {
		// Pins the rejected arm of the status ternary: a rejected wire outcome must
		// rehydrate as "rejected" (the "Dismissed." card), not collapse to accepted.
		const result: ThreadGetResult = {
			thread_id: "tRej",
			title: "T",
			messages: [
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "rr",
					segments: [
						{ kind: "text", text: "Logged." },
						{
							kind: "proposal",
							proposal_id: "p-r",
							mutation_kind: "create_journal_entry",
							status: "rejected",
						},
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
				id === "tRej" ? Effect.succeed(result) : Effect.die("unknown thread"),
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

		await hydrateThread(runtime, "tRej");

		expect(getChatState().proposals.rr?.status).toBe("rejected");

		await runtime.dispose();
	});

	it("ignores an unknown decided-proposal status (does not coerce to accepted)", async () => {
		// `status` is a bare wire string; a malformed/future value must be dropped,
		// not coerced to "accepted" (which would render a wrong "Applied." card).
		const result: ThreadGetResult = {
			thread_id: "tBad",
			title: "T",
			messages: [
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "rb",
					segments: [
						{ kind: "text", text: "Logged." },
						{
							kind: "proposal",
							proposal_id: "p-b",
							mutation_kind: "create_journal_entry",
							status: "superseded",
						},
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
				id === "tBad" ? Effect.succeed(result) : Effect.die("unknown thread"),
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

		await hydrateThread(runtime, "tBad");

		// No proposal reconstructed for an unrecognized status.
		expect(getChatState().proposals.rb).toBeUndefined();

		await runtime.dispose();
	});

	it("does NOT clobber a live pending Proposal with the rehydrated decided one", async () => {
		// A proposal/pending notification (or the became-live window) can attach a
		// live Proposal before hydration's settled view lands. The live one wins.
		setPendingProposal({
			proposal_id: "p-live",
			run_id: "rp",
			mutation_kind: "apply_intent_graph",
			payload: { entities: [], links: [] },
			rationale: "live",
			status: "pending",
		});
		const result: ThreadGetResult = {
			thread_id: "tProp2",
			title: "T",
			messages: [
				{
					id: "m2",
					role: "assistant",
					status: "completed",
					run_id: "rp",
					segments: [
						{ kind: "text", text: "Logged." },
						{
							kind: "proposal",
							proposal_id: "p-stale",
							mutation_kind: "apply_intent_graph",
							status: "accepted",
						},
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
				id === "tProp2" ? Effect.succeed(result) : Effect.die("unknown thread"),
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

		await hydrateThread(runtime, "tProp2");

		// The live (pending) Proposal is untouched; the stale settled view is dropped.
		expect(getChatState().proposals.rp?.proposal_id).toBe("p-live");
		expect(getChatState().proposals.rp?.status).toBe("pending");

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
					segments: [{ kind: "text", text: "hello" }],
				},
				{
					id: "m2",
					role: "assistant",
					status: "streaming",
					run_id: "r2",
					segments: [{ kind: "text", text: "echo: " }],
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
		expect(
			hydrated?.messages.map((m) => [m.role, concatText(m.segments), m.status]),
		).toEqual([
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
		expect(concatText(assistant?.segments ?? [])).toBe("echo: hello");
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
					segments: [{ kind: "text", text: "earlier" }],
				},
				{
					id: "s2",
					role: "assistant",
					status: "completed",
					run_id: "old",
					segments: [{ kind: "text", text: "earlier reply" }],
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
			run_id: "",
			segments: [{ kind: "text", text: "live message" }],
		});
		seedAssistantMessage("tC", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			run_id: "",
			segments: [],
		});
		attachRun("tC", "a1", "live-run");

		// Now let threadGet resolve with the (stale) server history.
		Effect.runSync(Deferred.succeed(gate, history));
		await hydrating;

		// The seeded live turn survives; fetched history is folded in front (older first).
		const thread = getChatState().threads.tC;
		expect(thread?.messages.map((m) => concatText(m.segments))).toEqual([
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
			run_id: "",
			segments: [{ kind: "text", text: "live message" }],
		});
		seedAssistantMessage("tD", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			run_id: "",
			segments: [],
		});
		attachRun("tD", "a1", "live-run");

		// Now let threadGet FAIL.
		Effect.runSync(Deferred.fail(gate, new WsRequestError({ reason: "boom" })));
		await hydrating;

		// The became-live arm of the failure callback wins: status is `ready`, not `error`.
		expect(getHydrationStatus("tD")).toBe("ready");
		// The live turn survives intact — no error screen painted over valid content.
		const thread = getChatState().threads.tD;
		expect(thread?.messages.map((m) => concatText(m.segments))).toEqual([
			"live message",
			"",
		]);
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
			run_id: "",
			segments: [{ kind: "text", text: "live message" }],
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
		expect(
			getChatState().threads.tRace?.messages.map((m) => concatText(m.segments)),
		).toEqual(["live message"]);

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
					segments: [{ kind: "text", text: "hi" }],
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
		expect(
			getChatState().threads.tFail?.messages.map((m) => concatText(m.segments)),
		).toEqual(["hi"]);

		await runtime.dispose();
		await okRuntime.dispose();
	});
});
