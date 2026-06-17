import { expect, test } from "./fixtures.js";
// FAUX_WORKER_CMD drives the parked-interpreter angle only (the describe block
// below); the wire test uses the default echo worker (which reaches `done`).
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * The recent-Runs feed end-to-end (ADR-0028 as-built). Two angles:
 *
 *  (a) Wire: drive two Runs to `done` over the browser WebSocket, call
 *      `run/get_history`, and assert it returns them newest-first with each
 *      Run's latest Run Log milestone `kind` verbatim and its Thread title —
 *      the runtime cross-check that Core's serialization and the TS schema agree.
 *
 *  (b) DOM: against a faux interpreter that parks on a Proposal, load the SPA,
 *      drive a Run, and assert the recent-Runs rail surfaces it with the
 *      milestone's mapped label ("Waiting" for a parked/proposal_pending Run).
 */

test("run/get_history returns driven Runs newest-first over the WebSocket", async ({
	core,
	page,
}) => {
	await page.goto(core.url);

	const result = await page.evaluate(async (baseUrl) => {
		type Frame = {
			id?: number;
			method?: string;
			result?: {
				run_id?: string;
				thread_id?: string;
				runs?: Array<{
					run_id: string;
					thread_id: string;
					title: string;
					kind: string;
					at: number;
				}>;
			};
			params?: { event?: { kind?: string } };
		};

		const wsUrl = `${baseUrl.replace(/^http:/, "ws:").replace(/\/$/, "")}/ws`;

		return await new Promise<{
			runs: NonNullable<NonNullable<Frame["result"]>["runs"]>;
		}>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			let nextId = 1;
			let runA = "";
			let runB = "";
			let settled = false;

			const fail = (e: Error) => {
				if (settled) return;
				settled = true;
				ws.close();
				reject(e);
			};
			const timeout = setTimeout(
				() => fail(new Error("timed out driving run history")),
				25_000,
			);
			const send = (id: number, method: string, params: unknown) =>
				ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));

			// Track which run each subscribe id is draining and whether it's done.
			const doneFor = new Set<string>();

			ws.addEventListener("error", () => fail(new Error("websocket error")));
			ws.addEventListener("open", () => {
				send(nextId++, "thread/create", { prompt: "first run alpha" });
			});

			ws.addEventListener("message", (m) => {
				let frame: Frame;
				try {
					frame = JSON.parse(String(m.data)) as Frame;
				} catch {
					return;
				}

				// thread/create for A.
				if (frame.id === 1) {
					runA = frame.result?.run_id ?? "";
					send(100, "run/subscribe", { run_id: runA }); // drain A
					return;
				}
				// thread/create for B (sent after A completes).
				if (frame.id === 2) {
					runB = frame.result?.run_id ?? "";
					send(200, "run/subscribe", { run_id: runB }); // drain B
					return;
				}

				// run/get_history result.
				if (frame.id === 999) {
					clearTimeout(timeout);
					settled = true;
					ws.close();
					resolve({ runs: frame.result?.runs ?? [] });
					return;
				}

				// Stream events: when a run reaches `done`, advance the sequence.
				if (
					frame.method === "run/event" &&
					frame.params?.event?.kind === "done"
				) {
					if (!doneFor.has("A") && runB === "") {
						doneFor.add("A");
						// Create B only after A is done so A's milestone is strictly older.
						send(2, "thread/create", { prompt: "second run beta" });
					} else if (!doneFor.has("B") && runB !== "") {
						doneFor.add("B");
						send(999, "run/get_history", {});
					}
				}
			});
		});
	}, core.url);

	expect(result.runs).toHaveLength(2);

	// Newest-first: B (created + completed second) precedes A.
	expect(result.runs[0].title).toBe("second run beta");
	expect(result.runs[0].kind).toBe("done");
	expect(result.runs[1].title).toBe("first run alpha");
	expect(result.runs[1].kind).toBe("done");

	// The recency key is monotone with the order.
	expect(result.runs[0].at).toBeGreaterThanOrEqual(result.runs[1].at);

	// thread_id is present and distinct per Run.
	expect(result.runs[0].thread_id).not.toBe(result.runs[1].thread_id);
});

test.describe("with a parked faux interpreter", () => {
	test.use({ coreOptions: { workerCmd: FAUX_WORKER_CMD, faux: "propose" } });

	test("the recent-Runs feed surfaces a parked Run as Waiting", async ({
		chat,
	}) => {
		await chat.goto();

		await chat.send("I bought milk after daycare pickup and felt relieved.");

		// The Run parks on a pending Proposal — its latest Run Log milestone is now
		// `proposal_pending`.
		await expect(chat.proposalCard()).toBeVisible({ timeout: 15_000 });

		// The feed is a one-shot read (ADR-0020: reads via TanStack Query, the live
		// stream stays on the store), like the sidebar's thread list — so reload to
		// re-read history, exactly what a user returning to the surface sees.
		await chat.goto();

		// The recent-Runs rail shows the parked Run with its mapped "Waiting" label.
		const feed = chat.page.getByRole("complementary", { name: /recent runs/i });
		await expect(feed).toBeVisible();
		await expect(feed.getByText(/Waiting/).first()).toBeVisible({
			timeout: 15_000,
		});
	});
});
