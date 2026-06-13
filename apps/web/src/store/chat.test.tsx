import { type RunEventValue, type RunId, WsClient } from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { awaitRun, resetBridge, send } from "./bridge.js";
import {
	appendUserMessage,
	getChatState,
	type Message,
	prependHistory,
	resetChatStore,
	seedAssistantMessage,
	setFocusedThread,
} from "./chat.js";

// Stub WsClient backed by an in-memory Queue — see docs/design/web-store-tests.md
function makeStubRuntime(queue: Queue.Queue<RunEventValue>, runId: RunId) {
	const unused = Effect.die("not used in slice 11");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => Effect.succeed(runId),
		threadList: () => unused,
		threadGet: () => unused,
		listEntities: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => Stream.fromQueue(queue),
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		proposalNotifications: () => Stream.empty,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
});

describe("chat store + stream bridge", () => {
	it("send → streamed assistant message → finalize on done", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-1");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "hi");

		const seeded = getChatState().threads.threadA;
		expect(seeded?.messages.map((m) => [m.role, m.text, m.status])).toEqual([
			["user", "hi", "completed"],
			["assistant", "", "streaming"],
		]);
		expect(seeded?.activeRunId).toBe("run-1");

		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "echo: hi" });
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-1");

		const finalized = getChatState().threads.threadA;
		const assistant = finalized?.messages[1];
		expect(assistant?.text).toBe("echo: hi");
		expect(assistant?.status).toBe("completed");
		expect(finalized?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("background thread keeps streaming when focus changes mid-run", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-A");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "hi");

		// Switch focus while threadA's run is in flight; its fiber must stay alive.
		setFocusedThread("threadB");

		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "part1" });
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "-part2" });
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-A");

		const threadA = getChatState().threads.threadA;
		const assistant = threadA?.messages[1];
		expect(assistant?.text).toBe("part1-part2");
		expect(assistant?.status).toBe("completed");
		expect(threadA?.activeRunId).toBeUndefined();
		expect(getChatState().focusedThreadId).toBe("threadB");

		await runtime.dispose();
	});

	it("error event finalizes the run: assistant incomplete, fiber settles", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-err");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "hi");

		// `error` is terminal: takeUntil releases the fiber with no `done` (ADR-0023).
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "partial" });
		Queue.unsafeOffer(queue, {
			kind: "error",
			message: "provider rejected the request",
		});
		await awaitRun(runtime, "run-err");

		const threadA = getChatState().threads.threadA;
		const assistant = threadA?.messages[1];
		expect(assistant?.text).toBe("partial");
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toBe("provider rejected the request");
		expect(threadA?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("cancelled event finalizes the run: partial text kept incomplete, fiber settles", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-cancel");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "hi");

		// `cancelled` is terminal but not an error: fiber releases, text stays incomplete (ADR-0014).
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "partial" });
		Queue.unsafeOffer(queue, { kind: "cancelled" });
		await awaitRun(runtime, "run-cancel");

		const threadA = getChatState().threads.threadA;
		const assistant = threadA?.messages[1];
		expect(assistant?.text).toBe("partial");
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toBeUndefined();
		expect(threadA?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("tool_call events upsert a running row then flip it to completed", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-tool");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "summarize my other thread");

		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "tc_1",
			name: "read_thread",
			status: "started",
		});
		Queue.unsafeOffer(queue, {
			kind: "text_delta",
			delta: "Here's what I found",
		});
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "tc_1",
			name: "read_thread",
			status: "completed",
		});
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-tool");

		const assistant = getChatState().threads.threadA?.messages[1];
		expect(assistant?.toolCalls).toEqual([
			{ id: "tc_1", name: "read_thread", status: "completed" },
		]);
		expect(assistant?.text).toBe("Here's what I found");
		expect(assistant?.status).toBe("completed");

		await runtime.dispose();
	});

	it("maps a tool_call error status onto the matching row", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-tool-err");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "read a missing thread");

		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "tc_2",
			name: "read_thread",
			status: "started",
		});
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "tc_2",
			name: "read_thread",
			status: "error",
		});
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-tool-err");

		const assistant = getChatState().threads.threadA?.messages[1];
		expect(assistant?.toolCalls).toEqual([
			{ id: "tc_2", name: "read_thread", status: "error" },
		]);

		await runtime.dispose();
	});

	it("tracks multiple concurrent tool calls independently, in arrival order", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-multi");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "do two things");

		// Two calls resolve out of order; each id upserts independently, rows keep first-seen order.
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "a",
			name: "read_thread",
			status: "started",
		});
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "b",
			name: "search_web",
			status: "started",
		});
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "b",
			name: "search_web",
			status: "error",
		});
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "a",
			name: "read_thread",
			status: "completed",
		});
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-multi");

		const assistant = getChatState().threads.threadA?.messages[1];
		expect(assistant?.toolCalls).toEqual([
			{ id: "a", name: "read_thread", status: "completed" },
			{ id: "b", name: "search_web", status: "error" },
		]);

		await runtime.dispose();
	});

	it("settles a still-running tool call when the run finishes (lost terminal boundary)", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-lost");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "hi");

		// Terminal tool_call lost (broadcast lag, ADR-0022 no replay); `done` must still settle the row.
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "x",
			name: "read_thread",
			status: "started",
		});
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-lost");

		const assistant = getChatState().threads.threadA?.messages[1];
		expect(assistant?.toolCalls).toEqual([
			{ id: "x", name: "read_thread", status: "completed" },
		]);
		expect(assistant?.status).toBe("completed");

		await runtime.dispose();
	});

	it("settles a still-running tool call to error when the run errors", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-lost-err");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "hi");

		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "x",
			name: "read_thread",
			status: "started",
		});
		Queue.unsafeOffer(queue, { kind: "error", message: "worker died" });
		await awaitRun(runtime, "run-lost-err");

		const assistant = getChatState().threads.threadA?.messages[1];
		expect(assistant?.toolCalls).toEqual([
			{ id: "x", name: "read_thread", status: "error" },
		]);
		expect(assistant?.status).toBe("incomplete");

		await runtime.dispose();
	});

	it("keeps SET-then-APPEND text semantics when a tool_call interleaves", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-interleave");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "hi");

		// A tool_call before the first text_delta must not consume the snapshot slot.
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "t",
			name: "read_thread",
			status: "started",
		});
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "A" });
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "B" });
		Queue.unsafeOffer(queue, {
			kind: "tool_call",
			tool_call_id: "t",
			name: "read_thread",
			status: "completed",
		});
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-interleave");

		const assistant = getChatState().threads.threadA?.messages[1];
		expect(assistant?.text).toBe("AB");
		expect(assistant?.toolCalls).toEqual([
			{ id: "t", name: "read_thread", status: "completed" },
		]);

		await runtime.dispose();
	});
});

describe("prependHistory", () => {
	const live = (id: string, run: string, text: string): Message => ({
		id,
		role: id.startsWith("u") ? "user" : "assistant",
		status: "completed",
		text,
		run_id: run,
	});

	it("folds fetched history in front of the live turn, skipping runs already present", () => {
		appendUserMessage("t1", live("u-live", "live", "live msg"));
		seedAssistantMessage("t1", {
			id: "a-live",
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "live",
		});

		// Fetched history includes the live run again; it must be skipped, older turn prepended.
		prependHistory("t1", [
			live("u-old", "old", "older msg"),
			live("a-old", "old", "older reply"),
			live("u-dup", "live", "dup user"),
			live("a-dup", "live", "dup assistant"),
		]);

		const msgs = getChatState().threads.t1?.messages ?? [];
		expect(msgs.map((m) => m.id)).toEqual([
			"u-old",
			"a-old",
			"u-live",
			"a-live",
		]);
	});

	it("is a no-op on an unknown thread or when every fetched run is already present", () => {
		prependHistory("missing", [live("x", "r", "x")]);
		expect(getChatState().threads.missing).toBeUndefined();

		appendUserMessage("t2", live("u", "r", "u"));
		prependHistory("t2", [live("dup", "r", "dup")]);
		expect(getChatState().threads.t2?.messages.map((m) => m.id)).toEqual(["u"]);
	});
});
