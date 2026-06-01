import { WsClient } from "@inkstone/ui-sdk";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { RuntimeProvider } from "@/runtime";
import { getChatState, resetChatStore } from "@/store/chat";
import { renderWithQuery } from "@/test-utils/renderWithQuery";
import { Sidebar } from "./Sidebar.js";

// Stub WsClient whose `threadList` returns a fixed set of threads. Sidebar reads
// them via TanStack Query running the SDK Effect on the runtime (the reads path).
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
		subscribeRun: () => unused,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

beforeEach(() => {
	resetChatStore();
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

		// Select a thread, then New Chat clears focus back to null.
		await user.click(await screen.findByText("Standup digest"));
		expect(getChatState().focusedThreadId).toBe("t-1");

		await user.click(screen.getByRole("button", { name: /new chat/i }));
		expect(getChatState().focusedThreadId ?? null).toBeNull();

		await runtime.dispose();
	});
});
