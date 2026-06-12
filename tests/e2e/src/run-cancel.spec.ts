import { expect, test } from "./fixtures.js";

test.use({ coreOptions: { chunks: 2 } });

test("browser WebSocket sees running cancel accepted then cancelled", async ({
	core,
	page,
}) => {
	await page.goto(core.url);

	const result = await page.evaluate(async (baseUrl) => {
		type Frame = {
			id?: number;
			method?: string;
			result?: { run_id?: string; outcome?: string; status?: string };
			params?: {
				event?: { kind?: string; delta?: string };
			};
		};

		const wsUrl = baseUrl.replace(/^http:/, "ws:").replace(/\/$/, "") + "/ws";
		const frames: Frame[] = [];

		return await new Promise<{
			readonly outcome: string;
			readonly terminal: string;
			readonly firstDelta: string;
			readonly frames: Frame[];
		}>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			let runId = "";
			let firstDelta = "";
			let cancelAccepted = false;
			let cancelled = false;
			let settled = false;

			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				ws.close();
				reject(error);
			};

			const finish = () => {
				if (settled) return;
				settled = true;
				ws.close();
				resolve({
					outcome: "accepted",
					terminal: "cancelled",
					firstDelta,
					frames,
				});
			};

			const send = (id: number, method: string, params: unknown) => {
				ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
			};

			const timeout = setTimeout(
				() => fail(new Error(`timed out; frames=${JSON.stringify(frames)}`)),
				10_000,
			);

			ws.addEventListener("open", () => {
				send(1, "thread/create", { prompt: "hello from browser" });
			});

			ws.addEventListener("error", () => {
				clearTimeout(timeout);
				fail(new Error("websocket error"));
			});

			ws.addEventListener("message", (message) => {
				try {
					const frame = JSON.parse(String(message.data)) as Frame;
					frames.push(frame);

					if (frame.id === 1) {
						runId = frame.result?.run_id ?? "";
						if (runId.length === 0)
							throw new Error("thread/create had no run_id");
						send(2, "run/subscribe", { run_id: runId });
						return;
					}

					if (frame.id === 2) {
						if (frame.result?.status !== "running") {
							throw new Error(
								`expected running subscribe status: ${message.data}`,
							);
						}
						return;
					}

					if (frame.id === 3) {
						if (frame.result?.outcome !== "accepted") {
							throw new Error(`expected accepted cancel: ${message.data}`);
						}
						cancelAccepted = true;
						return;
					}

					if (frame.method !== "run/event") return;

					const event = frame.params?.event;
					if (event?.kind === "done") {
						throw new Error(`cancelled Run emitted done: ${message.data}`);
					}
					if (event?.kind === "text_delta" && firstDelta.length === 0) {
						firstDelta = event.delta ?? "";
						if (firstDelta.length > 0) {
							send(3, "run/cancel", { run_id: runId });
						}
						return;
					}
					if (event?.kind === "cancelled") {
						if (!cancelAccepted) {
							throw new Error(
								"cancelled event arrived before accepted response",
							);
						}
						cancelled = true;
						setTimeout(() => {
							clearTimeout(timeout);
							if (!cancelled) {
								fail(new Error("cancelled event was not observed"));
								return;
							}
							finish();
						}, 300);
					}
				} catch (error) {
					clearTimeout(timeout);
					fail(error instanceof Error ? error : new Error(String(error)));
				}
			});
		});
	}, core.url);

	expect(result.outcome).toBe("accepted");
	expect(result.terminal).toBe("cancelled");
	expect(result.firstDelta.length).toBeGreaterThan(0);
	expect(
		result.frames.some((frame) => frame.params?.event?.kind === "done"),
	).toBe(false);
});
