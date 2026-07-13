import type { Page } from "@playwright/test";

/** Drive one chat Run to completion from inside the page: open the Core
 * websocket, `thread/create` with `prompt`, `run/subscribe`, accumulate
 * `text_delta`s, and resolve on `done` (reject on `error` or a 15s timeout).
 * Shared by the sibling-binary worker specs, whose assertions differ only in
 * WHY the echo could appear — the drive itself is identical. */
export async function driveEchoRun(
	page: Page,
	coreUrl: string,
	prompt: string,
): Promise<{ readonly text: string; readonly done: boolean }> {
	return await page.evaluate(
		async ({ baseUrl, prompt }) => {
			type Frame = {
				id?: number;
				result?: { run_id?: string };
				method?: string;
				params?: { event?: { kind?: string; delta?: string } };
			};

			const wsUrl = `${baseUrl.replace(/^http:/, "ws:").replace(/\/$/, "")}/ws`;

			return await new Promise<{
				readonly text: string;
				readonly done: boolean;
			}>((resolve, reject) => {
				const ws = new WebSocket(wsUrl);
				let runId = "";
				let text = "";
				let settled = false;

				const timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					ws.close();
					reject(new Error("timed out before the Run reached done"));
				}, 15_000);

				const send = (id: number, method: string, params: unknown) => {
					ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
				};

				ws.addEventListener("open", () => {
					send(1, "thread/create", { prompt });
				});

				ws.addEventListener("error", () => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					reject(new Error("websocket error"));
				});

				ws.addEventListener("message", (message) => {
					try {
						const frame = JSON.parse(String(message.data)) as Frame;

						if (frame.id === 1) {
							runId = frame.result?.run_id ?? "";
							if (runId.length === 0) {
								throw new Error("thread/create returned no run_id");
							}
							send(2, "run/subscribe", { run_id: runId });
							return;
						}

						if (frame.method !== "run/event") return;
						const event = frame.params?.event;
						if (event?.kind === "text_delta") {
							text += event.delta ?? "";
							return;
						}
						if (event?.kind === "error") {
							throw new Error(`Run emitted error event: ${message.data}`);
						}
						if (event?.kind === "done") {
							settled = true;
							clearTimeout(timeout);
							ws.close();
							resolve({ text, done: true });
						}
					} catch (error) {
						if (settled) return;
						settled = true;
						clearTimeout(timeout);
						ws.close();
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				});
			});
		},
		{ baseUrl: coreUrl, prompt },
	);
}
