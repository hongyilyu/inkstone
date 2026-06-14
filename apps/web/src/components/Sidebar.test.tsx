import { type RunEventValue, WsClient } from "@inkstone/ui-sdk";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { resetBridge } from "@/store/bridge";
import { getChatState, resetChatStore } from "@/store/chat";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { ChatColumn } from "./ChatColumn.js";
import { Sidebar } from "./Sidebar.js";

// Stub WsClient whose `threadList` returns a fixed set of threads.
function makeStubRuntime() {
	const unused = Effect.die("not exercised in this test");
	const stub = WsClient.of({
		threadCreate: () => unused,
		postMessage: () => unused,
		threadList: () =>
			Effect.succeed({
				threads: [
					{ id: "t-1", title: "Standup digest", last_activity_at: 2 },
					{ id: "t-2", title: "API rename plan", last_activity_at: 1 },
				],
			}),
		threadGet: () => unused,
		listEntities: () => unused,
		entityMutate: () => unused,
		subscribeRun: () => unused,
		cancelRun: () => unused,
		providerStatus: () => unused,
		providerLoginStart: () => unused,
		modelCatalog: () => unused,
		settingsGet: () => unused,
		settingsSet: () => unused,
		proposalGet: () => unused,
		proposalDecide: () => unused,
		messageSearch: () => unused,
		proposalNotifications: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

// Stub whose thread list grows on `threadCreate`, so a fresh read after creation includes the new thread.
function makeGrowingStubRuntime(opts: {
	readonly newThreadId: string;
	readonly runId: string;
	readonly events: readonly RunEventValue[];
}) {
	const threads: { id: string; title: string; last_activity_at: number }[] = [];
	const stub = WsClient.of({
		threadCreate: (prompt: string) =>
			Effect.sync(() => {
				threads.unshift({
					id: opts.newThreadId,
					title: prompt,
					last_activity_at: threads.length + 1,
				});
				return { thread_id: opts.newThreadId, run_id: opts.runId };
			}),
		postMessage: () => Effect.succeed(opts.runId),
		threadList: () => Effect.sync(() => ({ threads: [...threads] })),
		threadGet: () => Effect.die("not exercised"),
		listEntities: () => Effect.die("not exercised"),
		entityMutate: () => Effect.die("not exercised"),
		subscribeRun: () => Stream.fromIterable(opts.events),
		cancelRun: () => Effect.die("not exercised"),
		providerStatus: () => Effect.die("not exercised"),
		providerLoginStart: () => Effect.die("not exercised"),
		modelCatalog: () => Effect.die("not exercised"),
		settingsGet: () => Effect.die("not exercised"),
		settingsSet: () => Effect.die("not exercised"),
		proposalGet: () => Effect.die("not exercised"),
		proposalDecide: () => Effect.die("not exercised"),
		messageSearch: () => Effect.die("not exercised"),
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

describe("Sidebar", () => {
	it("lists threads from a thread/list read and selects one into focus", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<Sidebar />
			</RuntimeProvider>,
		);

		const first = await screen.findByText("Standup digest");
		expect(await screen.findByText("API rename plan")).toBeInTheDocument();

		await user.click(first);

		expect(getChatState().focusedThreadId).toBe("t-1");

		await runtime.dispose();
	});

	it("keeps the New Chat button and clears focus on click", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<Sidebar />
			</RuntimeProvider>,
		);

		await user.click(await screen.findByText("Standup digest"));
		expect(getChatState().focusedThreadId).toBe("t-1");

		await user.click(screen.getByRole("button", { name: /new chat/i }));
		expect(getChatState().focusedThreadId ?? null).toBeNull();

		await runtime.dispose();
	});

	it("shows a newly-created thread without a manual reload", async () => {
		const user = userEvent.setup();
		const runtime = makeGrowingStubRuntime({
			newThreadId: "thread-new",
			runId: "run-1",
			events: [{ kind: "text_delta", delta: "echo: hi" }, { kind: "done" }],
		});

		// Sidebar + ChatColumn share one runtime + QueryClient — the real app wiring.
		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<Sidebar />
				<ChatColumn />
			</RuntimeProvider>,
		);

		expect(await screen.findByText(/no threads yet/i)).toBeInTheDocument();

		await user.type(screen.getByRole("textbox", { name: /message/i }), "hi");
		await user.click(screen.getByRole("button", { name: /send/i }));

		// Sidebar surfaces the minted thread (title = prompt), proving thread/list was invalidated on create.
		expect(
			await screen.findByRole("button", { name: "hi" }),
		).toBeInTheDocument();

		await runtime.dispose();
	});

	it("copies a thread's id to the clipboard from its row button", async () => {
		const user = userEvent.setup();
		const runtime = makeStubRuntime();

		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});

		renderWithQuery(
			<RuntimeProvider runtime={runtime}>
				<Sidebar />
			</RuntimeProvider>,
		);

		// Copy-id control writes the thread id (not its title) to the clipboard.
		const copyBtn = await screen.findByRole("button", {
			name: /copy thread id for standup digest/i,
		});
		await user.click(copyBtn);

		expect(writeText).toHaveBeenCalledWith("t-1");

		await runtime.dispose();
	});
});
