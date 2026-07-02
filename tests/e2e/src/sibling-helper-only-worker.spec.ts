import { expect, test } from "./fixtures.js";
import { PROVIDER_HELPER_FIXTURE_BIN } from "./spawnCore.js";

/**
 * Regression for the `spawnCore` sibling-mode worker-config gap (PR #178 review):
 * the worker command and the provider-helper sibling are documented as
 * INDEPENDENT, but the original sibling block only configured the worker inside
 * the `else`/no-siblings branch — so `siblingBinaries: { providerHelper }` alone
 * (a worker sibling NOT provided) silently dropped both `opts.workerCmd` and the
 * `GATE_WORKER_CMD` default, leaving the tempdir Core with no worker to spawn.
 *
 * Here we boot Core with ONLY the provider-helper sibling and then drive a chat
 * Run. With the fix, `siblingWorker === undefined` still configures the default
 * GATE worker (the slow-worker fixture via INKSTONE_WORKER_CMD), so the Run
 * streams `echo: hello`. Before the fix, no worker command was set and no worker
 * sibling sat in the tempdir, so Core fell through to the real `tsx cli.ts`
 * worker, which errors without a configured provider — the Run never produces the
 * deterministic echo. The assertion below is therefore RED before the fix.
 */
test.use({
	coreOptions: {
		siblingBinaries: { providerHelper: PROVIDER_HELPER_FIXTURE_BIN },
		// The provider-helper sibling is here to prove worker config, NOT to drive a
		// login — but this spec sends a Run, which the ADR-0062 run-creation gate
		// rejects unless a provider is connected. Seed one explicitly (overrides the
		// sibling-helper's default disconnected start).
		connectedProvider: true,
	},
});

test("provider-helper-only sibling mode still configures the default worker", async ({
	core,
	page,
}) => {
	await page.goto(core.url);

	const result = await page.evaluate(async (baseUrl) => {
		type Frame = {
			id?: number;
			result?: { run_id?: string };
			method?: string;
			params?: { event?: { kind?: string; delta?: string } };
		};
		const wsUrl = `${baseUrl.replace(/^http:/, "ws:").replace(/\/$/, "")}/ws`;
		return await new Promise<{ readonly text: string; readonly done: boolean }>(
			(resolve, reject) => {
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
			},
		);
	}, core.url);

	// Only producible if the default GATE worker (slow-worker fixture) was
	// configured despite no worker sibling being provided.
	expect(result.text).toBe("echo: hello");
	expect(result.done).toBe(true);
});
