import { type RunEventValue, WsClient } from "@inkstone/ui-sdk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";
import App from "./App.js";

describe("App", () => {
	it("renders user bubble on submit and assistant bubble after streamed events", async () => {
		const user = userEvent.setup();
		const queue = await Effect.runPromise(Queue.unbounded<RunEventValue>());
		const fakeRunId = "01234567-89ab-7def-8012-345678901234";

		const fakeLayer = Layer.succeed(
			WsClient,
			WsClient.of({
				postMessage: () => Effect.succeed(fakeRunId),
				subscribeRun: () =>
					Stream.fromQueue(queue).pipe(
						Stream.takeUntil((e) => e.kind === "done"),
					),
			}),
		);
		const testRuntime = ManagedRuntime.make(fakeLayer);

		try {
			render(<App runtime={testRuntime} />);

			await user.type(screen.getByRole("textbox"), "hello");
			await user.click(screen.getByRole("button", { name: /send/i }));

			expect(await screen.findByText("hello")).toBeInTheDocument();

			await Effect.runPromise(
				Queue.offer(queue, { kind: "text_delta", delta: "echo: hello" }),
			);
			await Effect.runPromise(Queue.offer(queue, { kind: "done" }));

			expect(await screen.findByText("echo: hello")).toBeInTheDocument();
		} finally {
			await testRuntime.dispose();
		}
	});
});
