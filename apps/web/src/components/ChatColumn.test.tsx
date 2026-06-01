import { type RunEventValue, WsClient } from "@inkstone/ui-sdk";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { resetBridge } from "@/store/bridge";
import { getChatState, resetChatStore, setFocusedThread } from "@/store/chat";
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
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

beforeEach(() => {
	resetChatStore();
	resetBridge();
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
});
