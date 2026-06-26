import {
	type RunEventValue,
	type RunId,
	WsClient,
	type WsError,
	WsRequestError,
} from "@inkstone/ui-sdk";
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
	type Message,
	prependHistory,
	resetChatStore,
	type Segment,
	seedAssistantMessage,
	setPendingProposal,
} from "./chat.js";

// Stub WsClient backed by an in-memory Queue — see docs/design/web-store-tests.md
function makeStubRuntime(queue: Queue.Queue<RunEventValue>, runId: RunId) {
	const unused = Effect.die("not used in slice 11");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => Effect.succeed(runId),
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
		connectionStatus: () => Stream.empty,
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

		await send(runtime, "threadA", "hi");

		const seeded = getChatState().threads.threadA;
		expect(
			seeded?.messages.map((m) => [m.role, concatText(m.segments), m.status]),
		).toEqual([
			["user", "hi", "completed"],
			["assistant", "", "streaming"],
		]);
		expect(seeded?.activeRunId).toBe("run-1");

		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "echo: hi" });
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-1");

		const finalized = getChatState().threads.threadA;
		const assistant = finalized?.messages[1];
		expect(concatText(assistant?.segments ?? [])).toBe("echo: hi");
		expect(assistant?.status).toBe("completed");
		expect(finalized?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("a run keeps streaming to completion independently of which thread is focused", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-A");

		// Run lives in the bridge's fiber map, not tied to focus (which is the URL
		// now, ADR-0042): the stream settles regardless of any navigation.
		await send(runtime, "threadA", "hi");

		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "part1" });
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "-part2" });
		Queue.unsafeOffer(queue, { kind: "done" });
		await awaitRun(runtime, "run-A");

		const threadA = getChatState().threads.threadA;
		const assistant = threadA?.messages[1];
		expect(concatText(assistant?.segments ?? [])).toBe("part1-part2");
		expect(assistant?.status).toBe("completed");
		expect(threadA?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("error event finalizes the run: assistant incomplete, fiber settles", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-err");

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
		expect(concatText(assistant?.segments ?? [])).toBe("partial");
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toBe("provider rejected the request");
		// A failure is NOT a cancellation: no `cancelled` flag, so the bubble renders
		// the destructive error alert, not the calm "stopped" notice (ADR-0014).
		expect(assistant?.cancelled).toBeUndefined();
		expect(threadA?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("cancelled event finalizes the run: partial text kept incomplete, fiber settles", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-cancel");

		await send(runtime, "threadA", "hi");

		// `cancelled` is terminal but not an error: fiber releases, text stays incomplete (ADR-0014).
		Queue.unsafeOffer(queue, { kind: "text_delta", delta: "partial" });
		Queue.unsafeOffer(queue, { kind: "cancelled" });
		await awaitRun(runtime, "run-cancel");

		const threadA = getChatState().threads.threadA;
		const assistant = threadA?.messages[1];
		expect(concatText(assistant?.segments ?? [])).toBe("partial");
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toBeUndefined();
		// A user cancel is flagged so the bubble renders the calm "stopped" notice
		// rather than the destructive failure alert (ADR-0014).
		expect(assistant?.cancelled).toBe(true);
		expect(threadA?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("a transport failure mid-stream settles the turn as an error (no eternal typing)", async () => {
		// A WS drop mid-stream (laptop sleep, Core restart) fails the subscribe stream
		// rather than emitting a terminal event. Without a failure handler the fiber
		// would die silently and the bubble would hang at `streaming` forever with a
		// live Stop button. The bridge's catchAll must synthesize a terminal error.
		const stub = WsClient.of({
			threadCreate: () => Effect.die("unused"),
			postMessage: () => Effect.succeed("run-drop" as RunId),
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
			// Emit one delta, then FAIL the stream like a dropped socket would.
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

		await send(runtime, "threadA", "hi");
		await awaitRun(runtime, "run-drop" as RunId);

		const threadA = getChatState().threads.threadA;
		const assistant = threadA?.messages[1];
		expect(concatText(assistant?.segments ?? [])).toBe("partial");
		expect(assistant?.status).toBe("incomplete");
		expect(assistant?.error).toMatch(/lost the connection/i);
		// A transport failure is NOT a user cancel — render the error alert.
		expect(assistant?.cancelled).toBeUndefined();
		expect(threadA?.activeRunId).toBeUndefined();

		await runtime.dispose();
	});

	it("tool_call events upsert a running row then flip it to completed", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-tool");

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
		expect(
			(assistant?.segments ?? [])
				.filter((s) => s.kind === "tool_call")
				.map((s) => s.call),
		).toEqual([{ id: "tc_1", name: "read_thread", status: "completed" }]);
		expect(concatText(assistant?.segments ?? [])).toBe("Here's what I found");
		expect(assistant?.status).toBe("completed");

		await runtime.dispose();
	});

	it("maps a tool_call error status onto the matching row", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-tool-err");

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
		expect(
			(assistant?.segments ?? [])
				.filter((s) => s.kind === "tool_call")
				.map((s) => s.call),
		).toEqual([{ id: "tc_2", name: "read_thread", status: "error" }]);

		await runtime.dispose();
	});

	it("tracks multiple concurrent tool calls independently, in arrival order", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-multi");

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
		expect(
			(assistant?.segments ?? [])
				.filter((s) => s.kind === "tool_call")
				.map((s) => s.call),
		).toEqual([
			{ id: "a", name: "read_thread", status: "completed" },
			{ id: "b", name: "search_web", status: "error" },
		]);

		await runtime.dispose();
	});

	it("settles a still-running tool call when the run finishes (lost terminal boundary)", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-lost");

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
		expect(
			(assistant?.segments ?? [])
				.filter((s) => s.kind === "tool_call")
				.map((s) => s.call),
		).toEqual([{ id: "x", name: "read_thread", status: "completed" }]);
		expect(assistant?.status).toBe("completed");

		await runtime.dispose();
	});

	it("settles a still-running tool call to error when the run errors", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-lost-err");

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
		expect(
			(assistant?.segments ?? [])
				.filter((s) => s.kind === "tool_call")
				.map((s) => s.call),
		).toEqual([{ id: "x", name: "read_thread", status: "error" }]);
		expect(assistant?.status).toBe("incomplete");

		await runtime.dispose();
	});

	it("keeps SET-then-APPEND text semantics when a tool_call interleaves", async () => {
		const queue = Effect.runSync(Queue.unbounded<RunEventValue>());
		const runtime = makeStubRuntime(queue, "run-interleave");

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
		expect(concatText(assistant?.segments ?? [])).toBe("AB");
		expect(
			(assistant?.segments ?? [])
				.filter((s) => s.kind === "tool_call")
				.map((s) => s.call),
		).toEqual([{ id: "t", name: "read_thread", status: "completed" }]);

		await runtime.dispose();
	});
});

// The scroll-to-message anchor (issue #138) is now URL search-param state
// (`?focusedMessageId=`, ADR-0042), not a store field — its behavior is proven in
// ChatColumn.test.tsx (scroll + highlight + consume-then-strip) and the
// scroll-to-message e2e, not here.

describe("prependHistory", () => {
	const live = (id: string, run: string, text: string): Message => ({
		id,
		role: id.startsWith("u") ? "user" : "assistant",
		status: "completed",
		run_id: run,
		segments: text !== "" ? [{ kind: "text", text }] : [],
	});

	it("folds fetched history in front of the live turn, skipping runs already present", () => {
		appendUserMessage("t1", live("u-live", "live", "live msg"));
		seedAssistantMessage("t1", {
			id: "a-live",
			role: "assistant",
			status: "streaming",
			segments: [],
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

describe("segment timeline (ADR-0045)", () => {
	/** Seed a live assistant turn bound to `runId`, snapshot armed (the live-send shape). */
	function seedRun(threadId: string, runId: string): void {
		const id = "a-seg";
		seedAssistantMessage(threadId, {
			id,
			role: "assistant",
			status: "streaming",
			segments: [],
			run_id: "",
		});
		attachRun(threadId, id, runId);
		beginRunSubscription(threadId, runId);
	}

	function segmentsOf(threadId: string, runId: string): readonly Segment[] {
		const msg = getChatState().threads[threadId]?.messages.find(
			(m) => m.run_id === runId,
		);
		return msg?.segments ?? [];
	}

	it("orders segments by event arrival; post-proposal text opens a NEW segment", () => {
		seedRun("tSeg", "run-seg");

		// The screenshot scenario, live: text → search(started→completed) → propose → reply.
		applyEvent("tSeg", "run-seg", { kind: "text_delta", delta: "a" });
		applyEvent("tSeg", "run-seg", {
			kind: "tool_call",
			tool_call_id: "tc",
			name: "search_entities",
			status: "started",
		});
		applyEvent("tSeg", "run-seg", {
			kind: "tool_call",
			tool_call_id: "tc",
			name: "search_entities",
			status: "completed",
		});
		setPendingProposal({
			proposal_id: "p-seg",
			run_id: "run-seg",
			mutation_kind: "create_journal_entry",
			payload: null,
			rationale: null,
			status: "pending",
		});
		// The post-proposal delta is NOT armed (the first delta disarmed it) and the
		// trailing segment is a proposal, so "b" must open a NEW text segment.
		applyEvent("tSeg", "run-seg", { kind: "text_delta", delta: "b" });

		expect(segmentsOf("tSeg", "run-seg")).toEqual([
			{ kind: "text", text: "a" },
			{
				kind: "tool_call",
				call: { id: "tc", name: "search_entities", status: "completed" },
			},
			{ kind: "proposal", runId: "run-seg" },
			{ kind: "text", text: "b" },
		]);
	});

	it("a resume cumulative snapshot reconciles multiple pre-park text runs without duplicating the prefix (B1)", () => {
		// B1 regression: a turn with ≥2 pre-park text runs (text → tool → text → park →
		// resume). Core's resume snapshot is the CUMULATIVE concat of ALL the turn's text
		// (group_concat, select_run_snapshot), delivered as the armed first delta. The
		// prior rule replaced only the LAST text segment, leaving the earlier one in place
		// → concatText duplicated the prefix ("First. " + "First. Second. "). The fix
		// collapses every text segment into the single snapshot at the first text slot,
		// preserving the interleaved tool/proposal positions.
		seedRun("tB1", "run-b1");

		applyEvent("tB1", "run-b1", { kind: "text_delta", delta: "First. " });
		applyEvent("tB1", "run-b1", {
			kind: "tool_call",
			tool_call_id: "tc",
			name: "search_entities",
			status: "started",
		});
		applyEvent("tB1", "run-b1", {
			kind: "tool_call",
			tool_call_id: "tc",
			name: "search_entities",
			status: "completed",
		});
		// Second pre-park text run (disarmed APPEND opens a fresh segment after the tool).
		applyEvent("tB1", "run-b1", { kind: "text_delta", delta: "Second. " });
		setPendingProposal({
			proposal_id: "p-b1",
			run_id: "run-b1",
			mutation_kind: "create_journal_entry",
			payload: null,
			rationale: null,
			status: "pending",
		});

		// Resume re-subscribe re-arms the snapshot; its first delta is the cumulative text.
		beginRunSubscription("tB1", "run-b1");
		applyEvent("tB1", "run-b1", {
			kind: "text_delta",
			delta: "First. Second. ",
		});
		// The genuine reply opens a NEW text segment after the proposal marker.
		applyEvent("tB1", "run-b1", { kind: "text_delta", delta: "Done." });
		applyEvent("tB1", "run-b1", { kind: "done" });

		const segs = segmentsOf("tB1", "run-b1");
		// The pre-park prefix appears exactly once (no duplicated "First. ").
		expect(segs).toEqual([
			{ kind: "text", text: "First. Second. " },
			{
				kind: "tool_call",
				call: { id: "tc", name: "search_entities", status: "completed" },
			},
			{ kind: "proposal", runId: "run-b1" },
			{ kind: "text", text: "Done." },
		]);
		// The render-source invariant holds: concatText(segments) === the flat reply text.
		expect(concatText(segs)).toBe("First. Second. Done.");
	});

	it("appends a proposal segment exactly once per run (skip-if-present)", () => {
		seedRun("tDup", "run-dup");
		const proposal = {
			proposal_id: "p-dup",
			run_id: "run-dup",
			mutation_kind: "create_journal_entry",
			payload: null,
			rationale: null,
			status: "pending" as const,
		};
		setPendingProposal(proposal);
		// A status flip re-attaches the same run's proposal; the segment must not double up.
		setPendingProposal({ ...proposal, status: "accepted" });

		const segs = segmentsOf("tDup", "run-dup");
		expect(segs.filter((s) => s.kind === "proposal")).toHaveLength(1);
	});

	it("a reasoning_delta opens a reasoning segment; a second delta appends into it", () => {
		seedRun("tR", "run-r");

		applyEvent("tR", "run-r", { kind: "reasoning_delta", delta: "A" });
		applyEvent("tR", "run-r", { kind: "reasoning_delta", delta: "B" });

		expect(segmentsOf("tR", "run-r")).toEqual([
			{ kind: "reasoning", text: "AB" },
		]);
	});

	it("a text_delta then a reasoning_delta produce two distinct segments in order", () => {
		seedRun("tRT", "run-rt");

		applyEvent("tRT", "run-rt", { kind: "text_delta", delta: "reply" });
		applyEvent("tRT", "run-rt", { kind: "reasoning_delta", delta: "thinking" });

		expect(segmentsOf("tRT", "run-rt")).toEqual([
			{ kind: "text", text: "reply" },
			{ kind: "reasoning", text: "thinking" },
		]);
	});

	it("a terminal stamps a web-clocked durationMs on the open reasoning segment", () => {
		seedRun("tRD", "run-rd");

		// The injectable `now` makes the open→seal clocking deterministic: the run
		// record's open-time is set to `now` when the fresh reasoning segment opens;
		// the terminal stamps `now − openedAt` (ADR-0045: live clocks its own).
		const opened = 1_000;
		applyEvent(
			"tRD",
			"run-rd",
			{ kind: "reasoning_delta", delta: "why" },
			opened,
		);
		applyEvent("tRD", "run-rd", { kind: "done" }, opened + 1_500);

		expect(segmentsOf("tRD", "run-rd")).toEqual([
			{ kind: "reasoning", text: "why", durationMs: 1_500 },
		]);
	});

	it("a text_delta after reasoning seals that block's duration mid-stream, not at terminal", () => {
		seedRun("tRTseal", "run-rtseal");

		// The model thinks, then starts replying: the reasoning block is sealed the
		// moment the reply text arrives (open→seal), so the disclosure reads
		// "Thought for Ns" while the reply streams below — never a stale "Thinking…".
		const opened = 1_000;
		applyEvent(
			"tRTseal",
			"run-rtseal",
			{ kind: "reasoning_delta", delta: "weighing it" },
			opened,
		);
		applyEvent(
			"tRTseal",
			"run-rtseal",
			{ kind: "text_delta", delta: "Here is the answer." },
			opened + 2_000,
		);

		expect(segmentsOf("tRTseal", "run-rtseal")).toEqual([
			{ kind: "reasoning", text: "weighing it", durationMs: 2_000 },
			{ kind: "text", text: "Here is the answer." },
		]);
	});

	it("a tool_call(started) after reasoning seals that block's duration mid-stream", () => {
		seedRun("tRTool", "run-rtool");

		// The model thinks, then calls a tool: a `started` tool_call is a boundary the
		// same as a text delta — it seals the open reasoning block's web-clocked
		// duration NOW, so the disclosure reads "Thought for Ns" beside the tool row,
		// not a stale "Thinking…" until the Run terminates.
		const opened = 1_000;
		applyEvent(
			"tRTool",
			"run-rtool",
			{ kind: "reasoning_delta", delta: "parsing" },
			opened,
		);
		applyEvent(
			"tRTool",
			"run-rtool",
			{
				kind: "tool_call",
				tool_call_id: "tc_1",
				name: "search_entities",
				status: "started",
			},
			opened + 2_500,
		);

		expect(segmentsOf("tRTool", "run-rtool")).toEqual([
			{ kind: "reasoning", text: "parsing", durationMs: 2_500 },
			{
				kind: "tool_call",
				call: { id: "tc_1", name: "search_entities", status: "running" },
			},
		]);
	});

	it("times each block of a reasoning→text→reasoning interleave separately", () => {
		seedRun("tRTR", "run-rtr");

		const t0 = 1_000;
		applyEvent(
			"tRTR",
			"run-rtr",
			{ kind: "reasoning_delta", delta: "first" },
			t0,
		);
		// Text at t0+1s seals block 1 at 1000ms, and re-arms the open-time slot.
		applyEvent(
			"tRTR",
			"run-rtr",
			{ kind: "text_delta", delta: "mid" },
			t0 + 1_000,
		);
		// A second reasoning block opens fresh (its own open-time)…
		applyEvent(
			"tRTR",
			"run-rtr",
			{ kind: "reasoning_delta", delta: "second" },
			t0 + 1_000,
		);
		// …and the terminal seals it at 3000ms — block 1's 1000ms is untouched.
		applyEvent("tRTR", "run-rtr", { kind: "done" }, t0 + 4_000);

		expect(segmentsOf("tRTR", "run-rtr")).toEqual([
			{ kind: "reasoning", text: "first", durationMs: 1_000 },
			{ kind: "text", text: "mid" },
			{ kind: "reasoning", text: "second", durationMs: 3_000 },
		]);
	});
});

describe("concatText", () => {
	it("concatenates only the text segments, in order", () => {
		expect(
			concatText([
				{ kind: "text", text: "x" },
				{
					kind: "tool_call",
					call: { id: "t", name: "n", status: "completed" },
				},
				{ kind: "text", text: "y" },
			]),
		).toBe("xy");
	});

	it("excludes a reasoning segment — the thinking trace never leaks into the reply", () => {
		// The no-leak LOCK (ADR-0045): the copyable reply text / ⌘K search-match /
		// typing-indicator all derive from concatText, which must NEVER surface the
		// reasoning trace.
		expect(
			concatText([
				{ kind: "text", text: "A" },
				{ kind: "reasoning", text: "secret" },
			]),
		).toBe("A");
	});
});
