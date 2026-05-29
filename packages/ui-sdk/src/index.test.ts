import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { WsClient, WsClientConfig, WsClientLive } from "./index.js";

describe("WsClient", () => {
	it("postMessage returns the run_id and subscribeRun yields the run's events", async () => {
		const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
		await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
		const port = (wss.address() as { port: number }).port;
		const url = `ws://127.0.0.1:${port}/ws`;

		const expectedRunId = "01234567-89ab-7def-8012-345678901234";

		wss.on("connection", (ws) => {
			ws.on("message", (data) => {
				const req = JSON.parse(data.toString());
				if (req.method === "run/post_message") {
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							id: req.id,
							result: { run_id: expectedRunId },
						}),
					);
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "run/event",
							params: {
								run_id: expectedRunId,
								event: { kind: "text_delta", delta: "echo: hi" },
							},
						}),
					);
					ws.send(
						JSON.stringify({
							jsonrpc: "2.0",
							method: "run/event",
							params: {
								run_id: expectedRunId,
								event: { kind: "done" },
							},
						}),
					);
				}
			});
		});

		const program = Effect.gen(function* () {
			const client = yield* WsClient;
			const runId = yield* client.postMessage("hi");
			const events = yield* Stream.runCollect(
				client
					.subscribeRun(runId)
					.pipe(Stream.takeUntil((e) => e.kind === "done")),
			);
			return { runId, events: Array.from(events) };
		});

		try {
			const { runId, events } = await Effect.runPromise(
				program.pipe(
					Effect.scoped,
					Effect.provide(
						WsClientLive.pipe(
							Layer.provide(Layer.succeed(WsClientConfig, { url })),
						),
					),
				),
			);

			expect(runId).toBe(expectedRunId);
			expect(events).toEqual([
				{ kind: "text_delta", delta: "echo: hi" },
				{ kind: "done" },
			]);
		} finally {
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		}
	});
});
