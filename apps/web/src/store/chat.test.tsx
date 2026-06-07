import { type RunEventValue, type RunId, WsClient } from "@inkstone/ui-sdk";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { awaitRun, resetBridge, send } from "./bridge.js";
import { getChatState, resetChatStore, setFocusedThread } from "./chat.js";

// A stub WsClient backed by an in-memory Queue the test offers events to.
// This is the slice-10 RuntimeProvider injection seam: a runtime built from
// `ManagedRuntime.make(Layer.succeed(WsClient, stub))` (no real socket). Only
// postMessage + subscribeRun are exercised here; the rest never run.
function makeStubRuntime(queue: Queue.Queue<RunEventValue>, runId: RunId) {
	const unused = Effect.die("not used in slice 11");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => Effect.succeed(runId),
		threadList: () => unused,
		threadGet: () => unused,
		listTodos: () => unused,
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

		// send appends a user message and seeds a live assistant message.
		await send(runtime, "threadA", "hi");

		const seeded = getChatState().threads.threadA;
		expect(seeded?.messages.map((m) => [m.role, m.text, m.status])).toEqual([
			["user", "hi", "completed"],
			["assistant", "", "streaming"],
		]);
		expect(seeded?.activeRunId).toBe("run-1");

		// Drive the stream: one cumulative-snapshot text_delta, then done.
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

		// Switch focus to a different thread WHILE threadA's run is in flight.
		setFocusedThread("threadB");

		// threadA's run keeps streaming: SET (first delta) then APPEND, then done.
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "part1" });
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "-part2" });
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-A");

		// The backgrounded run's fiber stayed alive across the focus change:
		// its assistant message accumulated the full text and finalized.
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

		// Partial text streams, then the worker errors (ADR-0023). `error` is
		// terminal: takeUntil must release the fiber even though no `done` follows.
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "partial" });
		Queue.unsafeOffer(queue, {
			kind: "error",
			message: "provider rejected the request",
		});
		// awaitRun resolves only if the stream fiber settled — i.e. takeUntil
		// fired on `error`. If error weren't treated as terminal this would hang.
		await awaitRun(runtime, "run-err");

		const threadA = getChatState().threads.threadA;
		const assistant = threadA?.messages[1];
		expect(assistant?.text).toBe("partial");
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toBe("provider rejected the request");
		expect(threadA?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("tool_call events upsert a running row then flip it to completed", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-tool");
		setFocusedThread("threadA");

		await send(runtime, "threadA", "summarize my other thread");

		// Core synthesizes a `started` boundary when it dispatches the tool, then
		// a terminal `completed` when the outcome returns.
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
		// The same tool_call_id is upserted, not duplicated: one row, terminal.
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

		// Two calls start; they resolve out of order. Each id is upserted
		// independently and the rows keep their first-seen order.
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

		// `started` arrives, but the terminal `tool_call` is lost (broadcast lag,
		// ADR-0022 does not replay it). `done` must still settle the row so the
		// indicator doesn't animate forever on a finished turn.
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

		// A tool_call before the first text_delta must NOT consume the snapshot
		// slot: the first delta still SETs, the second APPENDs.
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
