import { expect, test } from "./fixtures.js";
import { WORKER_FIXTURE_BIN } from "./spawnCore.js";

/**
 * Compiled Worker, auto-detected end-to-end (ADR-0041, slice 3).
 *
 * Core is booted from an isolated tempdir with a compiled `inkstone-worker`
 * binary sitting NEXT TO its own executable and NO `INKSTONE_WORKER_CMD` set —
 * so the only way a Run can produce the fixture's `echo: <prompt>` output is
 * Core's ADR-0041 step-2 sibling auto-detection firing on `current_exe`'s
 * directory, spawning the sibling, and streaming its NDJSON back. The fixture
 * (the bun-compiled slow-worker) is deterministic and offline, so this proves
 * detection -> spawn -> stdio -> stream without a live provider.
 *
 * `global-setup.ts` compiles the fixture to a NON-real name; `spawnCore`'s
 * `siblingBinaries.worker` mode copies it to the real `inkstone-worker` name
 * inside the per-test tempdir (never `target/debug/inkstone-worker`, which
 * would hijack `pnpm dev` + other specs).
 */
test.use({ coreOptions: { siblingBinaries: { worker: WORKER_FIXTURE_BIN } } });

test("Core auto-detects + spawns a sibling worker binary and streams a Run", async ({
	core,
	page,
}) => {
	await page.goto(core.url);

	const result = await page.evaluate(async (baseUrl) => {
		type Frame = {
			id?: number;
			result?: { run_id?: string; status?: string };
			method?: string;
			params?: { event?: { kind?: string; delta?: string } };
		};

		const wsUrl = `${baseUrl.replace(/^http:/, "ws:").replace(/\/$/, "")}/ws`;

		return await new Promise<{ readonly text: string; readonly done: boolean }>(
			(resolve, reject) => {
				const ws = new WebSocket(wsUrl);
				let runId = "";
				let text = "";
				let done = false;
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
					send(1, "thread/create", { prompt: "hello" });
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
							done = true;
							settled = true;
							clearTimeout(timeout);
							ws.close();
							resolve({ text, done });
						}
					} catch (error) {
						if (settled) return;
						settled = true;
						clearTimeout(timeout);
						ws.close();
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				});
			},
		);
	}, core.url);

	// The reassembled stream is the fixture's `echo: <prompt>` — only producible
	// if Core auto-detected the sibling binary and drove it to completion.
	expect(result.text).toBe("echo: hello");
	expect(result.done).toBe(true);
});
