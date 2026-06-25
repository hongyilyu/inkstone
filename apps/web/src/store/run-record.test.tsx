import { type RunEventValue, type RunId, WsClient } from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { awaitRun, resetBridge, send } from "./bridge.js";
import {
	appendUserMessage,
	applyEvent,
	attachRun,
	beginRunSubscription,
	concatText,
	getChatState,
	getRun,
	getRunThreadId,
	isRunParked,
	resetChatStore,
	seedAssistantMessage,
	setPendingProposal,
	setProposalStatus,
} from "./chat.js";

// The Run lifecycle is ONE keyed record { status, threadId, snapshotArmed } — its
// state is a field read, not re-derived. These tests pin the record itself; the
// heavier fiber/race choreography stays in bridge.test.tsx / proposal.test.tsx.

/** Stub WsClient backed by an in-memory queue (mirrors chat.test.tsx). */
function makeStubRuntime(queue: Queue.Queue<RunEventValue>, runId: RunId) {
	const unused = Effect.die("not used in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => Effect.succeed(runId),
		threadList: () => unused,
		getRunHistory: () => unused,
		threadGet: () => unused,
		listEntities: () => unused,
		getBacklinks: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => Stream.fromQueue(queue),
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
		proposalNotifications: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

/** Seed a streaming assistant turn bound to `runId` (without forking a stream). */
function seedTurn(runId: RunId): void {
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
		segments: [],
		run_id: "",
	});
	attachRun("t1", "a1", runId);
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

describe("Run record — field reads", () => {
	it("beginRunSubscription materializes a running record armed for the snapshot", () => {
		beginRunSubscription("t1", "run-1");

		expect(getRun("run-1")).toEqual({
			status: "running",
			threadId: "t1",
			snapshotArmed: true,
		});
		// "which thread?" is a field read, not a linear scan over threads.
		expect(getRunThreadId("run-1")).toBe("t1");
		expect(isRunParked("run-1")).toBe(false);
	});

	it("an absent Run reads as undefined / not-parked", () => {
		expect(getRun("ghost")).toBeUndefined();
		expect(getRunThreadId("ghost")).toBeUndefined();
		expect(isRunParked("ghost")).toBe(false);
	});

	it("attaching a Proposal parks the Run (no live tail); a decided status stays parked", () => {
		beginRunSubscription("t1", "run-1");
		expect(isRunParked("run-1")).toBe(false);

		setPendingProposal({
			proposal_id: "p1",
			run_id: "run-1",
			mutation_kind: "create_journal_entry",
			payload: {},
			rationale: null,
			status: "pending",
		});
		expect(isRunParked("run-1")).toBe(true);
		expect(getRun("run-1")?.status).toBe("parked");

		// deciding has no resume tail yet → still parked.
		setProposalStatus("run-1", "deciding");
		expect(isRunParked("run-1")).toBe(true);

		// a failed decide leaves the Run parked (the resume never re-subscribed).
		setProposalStatus("run-1", "error");
		expect(isRunParked("run-1")).toBe(true);
	});

	it("re-subscribing a parked Run flips it back to running and re-arms the snapshot", () => {
		beginRunSubscription("t1", "run-1");
		setPendingProposal({
			proposal_id: "p1",
			run_id: "run-1",
			mutation_kind: "create_journal_entry",
			payload: {},
			rationale: null,
			status: "pending",
		});
		expect(isRunParked("run-1")).toBe(true);

		// The post-decide resume goes through the same begin verb → running + armed.
		beginRunSubscription("t1", "run-1");
		expect(getRun("run-1")).toEqual({
			status: "running",
			threadId: "t1",
			snapshotArmed: true,
		});
	});
});

describe("Run record — snapshot SET-vs-APPEND is a record read, not caller flag-juggling", () => {
	it("the first text_delta SETs (snapshot), disarming the bit; the rest APPEND", () => {
		// Drive applyEvent through the record verb only — no caller threads a flag.
		const runId = "run-1" as RunId;
		seedTurn(runId);
		beginRunSubscription("t1", runId);

		applyEvent("t1", runId, { kind: "text_delta", delta: "cumulative " });
		expect(getRun(runId)?.snapshotArmed).toBe(false);
		applyEvent("t1", runId, { kind: "text_delta", delta: "tail" });

		const msg = getChatState().threads.t1?.messages.find(
			(m) => m.run_id === runId,
		);
		expect(concatText(msg?.segments ?? [])).toBe("cumulative tail");
	});

	it("a re-armed resume SETs the cumulative snapshot over the on-screen prefix (M1)", () => {
		const runId = "run-1" as RunId;
		seedTurn(runId);

		// Original parked subscribe: first delta SETs the snapshot, then it parks.
		beginRunSubscription("t1", runId);
		applyEvent("t1", runId, { kind: "text_delta", delta: "Let me check. " });
		setPendingProposal({
			proposal_id: "p1",
			run_id: runId,
			mutation_kind: "create_journal_entry",
			payload: {},
			rationale: null,
			status: "pending",
		});

		// Resume re-subscribes through the same begin verb → re-arms snapshotArmed,
		// so the resume snapshot (which re-includes the pre-park prose) SETs.
		beginRunSubscription("t1", runId);
		applyEvent("t1", runId, { kind: "text_delta", delta: "Let me check. " });
		applyEvent("t1", runId, { kind: "text_delta", delta: "Done." });

		const msg = getChatState().threads.t1?.messages.find(
			(m) => m.run_id === runId,
		);
		// SET replaces the on-screen prefix; the M1 bug appended → duplicated prefix.
		expect(concatText(msg?.segments ?? [])).toBe("Let me check. Done.");
	});
});

describe("Run record — terminal transitions", () => {
	it("each terminal Run Event flips the record to terminal and clears the active run", async () => {
		for (const [runId, terminal] of [
			["run-done", { kind: "done" }],
			["run-err", { kind: "error", message: "boom" }],
			["run-cancel", { kind: "cancelled" }],
		] satisfies [string, RunEventValue][]) {
			resetChatStore();
			resetBridge();
			const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
			const runtime = makeStubRuntime(queue, runId as RunId);
			await send(runtime, "t1", "hi");
			expect(getRun(runId)?.status).toBe("running");

			Queue.unsafeOffer(queue, terminal);
			await awaitRun(runtime, runId as RunId);

			expect(getRun(runId)?.status).toBe("terminal");
			expect(getChatState().threads.t1?.activeRunId).toBeUndefined();
			await runtime.dispose();
		}
	});
});
