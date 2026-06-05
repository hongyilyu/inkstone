import { type RunEventValue, WsClient } from "@inkstone/ui-sdk";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { resetBridge } from "@/store/bridge";
import {
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
		subscribeRun: () => Stream.fromIterable(opts.events),
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
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
			expect(
				screen.getByTestId("copy-button-check"),
			).toBeInTheDocument();
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
});
