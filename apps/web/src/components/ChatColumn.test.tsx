import { type RunEventValue, WsClient } from "@inkstone/ui-sdk";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { resetBridge } from "@/store/bridge";
import {
	appendUserMessage,
	getChatState,
	resetChatStore,
	seedAssistantMessage,
	setFocusedThread,
} from "@/store/chat";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { ChatColumn } from "./ChatColumn.js";

// A stub WsClient driven through the slice-10 RuntimeProvider injection seam:
// a runtime built from `ManagedRuntime.make(Layer.succeed(WsClient, stub))`
// (no real socket). The send path runs `postMessage`/`threadCreate` on it; the
// stream bridge forks `subscribeRun`, whose finite event list drives the store.
function makeStubRuntime(opts: {
	readonly runId: string;
	readonly events: readonly RunEventValue[];
	readonly threadId?: string;
}) {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () =>
			Effect.succeed({
				thread_id: opts.threadId ?? "thread-new",
				run_id: opts.runId,
			}),
		postMessage: () => Effect.succeed(opts.runId),
		threadList: () => unused,
		threadGet: () => unused,
		listEntities: () => unused,
		subscribeRun: () => Stream.fromIterable(opts.events),
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

afterEach(() => {
	cleanup();
});

describe("ChatColumn", () => {
	it("sends into the focused thread and streams an echo reply", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-1",
			events: [{ kind: "text_delta", delta: "echo: hi" }, { kind: "done" }],
		});
		setFocusedThread("threadA");

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		const userBubble = await screen.findByText("hi");
		expect(userBubble.closest('[data-role="user"]')).toBeInTheDocument();

		const assistantBubble = await screen.findByText("echo: hi");
		expect(
			assistantBubble.closest('[data-role="assistant"]'),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("blocks blank sends via the composer trim-guard", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-x",
			events: [{ kind: "done" }],
		});
		setFocusedThread("threadA");

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		await user.type(screen.getByRole("textbox", { name: /message/i }), "   ");
		await user.click(screen.getByRole("button", { name: /send/i }));

		// ComposeFooter trims + guards → onSend never fires → no message appended.
		expect(getChatState().threads.threadA?.messages ?? []).toHaveLength(0);

		await runtime.dispose();
	});

	it("welcomes the user when no thread is focused and there are no messages", async () => {
		const runtime = makeStubRuntime({ runId: "run-welcome", events: [] });
		// No focused thread → fresh-chat welcome (teaches the Library loop).

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(
			screen.getByRole("heading", { name: /start a chat/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/land in your library/i)).toBeInTheDocument();

		await runtime.dispose();
	});

	it("shows a loading skeleton while a focused thread hydrates", async () => {
		const runtime = makeStubRuntime({ runId: "run-hydrate", events: [] });
		// A focused thread with no messages yet → hydrating skeleton, not a blank.
		setFocusedThread("threadA");

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(
			screen.getByRole("status", { name: /loading conversation/i }),
		).toBeInTheDocument();
		// The fresh-chat welcome must NOT show for an existing thread.
		expect(screen.queryByRole("heading", { name: /start a chat/i })).toBeNull();

		await runtime.dispose();
	});

	it("mints a new thread on the first send when none is focused", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-2",
			threadId: "thread-new",
			events: [{ kind: "text_delta", delta: "echo: hello" }, { kind: "done" }],
		});
		// No focused thread → send should mint one via threadCreate.

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hello");
		await user.click(screen.getByRole("button", { name: /send/i }));

		const userBubble = await screen.findByText("hello");
		expect(userBubble.closest('[data-role="user"]')).toBeInTheDocument();

		const assistantBubble = await screen.findByText("echo: hello");
		expect(
			assistantBubble.closest('[data-role="assistant"]'),
		).toBeInTheDocument();

		await waitFor(() => {
			expect(getChatState().focusedThreadId).toBe("thread-new");
		});

		await runtime.dispose();
	});

	it("shows a typing indicator for a streaming assistant message with no text", () => {
		const runtime = makeStubRuntime({ runId: "run-3", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a1",
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "r1",
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(screen.getByTestId("typing-indicator")).toBeInTheDocument();
	});

	it("hides the typing indicator once streamed text arrives", () => {
		const runtime = makeStubRuntime({ runId: "run-4", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a2",
			role: "assistant",
			status: "streaming",
			text: "hi",
			run_id: "r2",
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(screen.queryByTestId("typing-indicator")).toBeNull();
	});

	it("copies the message text and swaps to the Check icon on a completed assistant message", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		const runtime = makeStubRuntime({ runId: "run-6", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a4",
			role: "assistant",
			status: "completed",
			text: "hello world",
			run_id: "r4",
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		const copyButton = screen.getByRole("button", { name: /copy/i });
		await user.click(copyButton);

		expect(writeText).toHaveBeenCalledWith("hello world");
		await waitFor(() => {
			expect(screen.getByTestId("copy-button-check")).toBeInTheDocument();
		});
	});

	it("shows no copy button on a streaming assistant message", () => {
		const runtime = makeStubRuntime({ runId: "run-7", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a5",
			role: "assistant",
			status: "streaming",
			text: "partial response",
			run_id: "r5",
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
	});

	it("shows no copy button on an empty completed assistant message", () => {
		const runtime = makeStubRuntime({ runId: "run-8", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a6",
			role: "assistant",
			status: "completed",
			text: "",
			run_id: "r6",
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
	});

	it("shows no typing indicator on a completed (empty) assistant message", () => {
		const runtime = makeStubRuntime({ runId: "run-5", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a3",
			role: "assistant",
			status: "completed",
			text: "",
			run_id: "r3",
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(screen.queryByTestId("typing-indicator")).toBeNull();
	});

	it("renders a running tool call with its label and suppresses the typing dots", () => {
		const runtime = makeStubRuntime({ runId: "run-tc1", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a7",
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "r7",
			toolCalls: [{ id: "tc_1", name: "read_thread", status: "running" }],
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		const row = screen.getByTestId("tool-call");
		expect(row).toHaveAttribute("data-status", "running");
		expect(row).toHaveTextContent("Reading this thread");
		// read_thread is observe-only; the row says so (privacy/control).
		expect(row).toHaveTextContent(/read-only/i);
		// The tool indicator is the activity signal while a tool runs, so the
		// generic typing dots must not double up.
		expect(screen.queryByTestId("typing-indicator")).toBeNull();
	});

	it("renders a completed tool call in its settled past-tense state", () => {
		const runtime = makeStubRuntime({ runId: "run-tc2", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a8",
			role: "assistant",
			status: "completed",
			text: "done",
			run_id: "r8",
			toolCalls: [{ id: "tc_2", name: "read_thread", status: "completed" }],
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		const row = screen.getByTestId("tool-call");
		expect(row).toHaveAttribute("data-status", "completed");
		expect(row).toHaveTextContent("Read this thread");
	});

	it("surfaces an errored tool call with a failed indication", () => {
		const runtime = makeStubRuntime({ runId: "run-tc3", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a9",
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "r9",
			toolCalls: [{ id: "tc_3", name: "read_thread", status: "error" }],
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		const row = screen.getByTestId("tool-call");
		expect(row).toHaveAttribute("data-status", "error");
		expect(row).toHaveTextContent(/failed/i);
	});

	it("falls back to a humanized label for an unregistered tool", () => {
		const runtime = makeStubRuntime({ runId: "run-tc4", events: [] });
		setFocusedThread("threadA");
		seedAssistantMessage("threadA", {
			id: "a10",
			role: "assistant",
			status: "streaming",
			text: "",
			run_id: "r10",
			toolCalls: [{ id: "tc_4", name: "search_web", status: "running" }],
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(screen.getByTestId("tool-call")).toHaveTextContent("Search web");
	});

	it("offers Try again on an interrupted reply and re-sends the previous turn", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime({
			runId: "run-retry",
			events: [{ kind: "text_delta", delta: "recovered" }, { kind: "done" }],
		});
		setFocusedThread("threadA");
		appendUserMessage("threadA", {
			id: "u1",
			role: "user",
			status: "completed",
			text: "do it",
			run_id: "",
		});
		seedAssistantMessage("threadA", {
			id: "a-fail",
			role: "assistant",
			status: "incomplete",
			text: "",
			run_id: "r-fail",
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<ChatColumn />
			</RuntimeProvider>,
		);

		// Brand-voice, reassuring fallback when no specific error is attached.
		expect(screen.getByTestId("assistant-error")).toHaveTextContent(
			/nothing was saved without your approval/i,
		);

		await user.click(screen.getByRole("button", { name: /try again/i }));

		// The previous user turn is re-sent → a fresh assistant reply streams in.
		expect(await screen.findByText("recovered")).toBeInTheDocument();

		await runtime.dispose();
	});
});
