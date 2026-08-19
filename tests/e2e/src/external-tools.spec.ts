import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { asNumber, type JsonObject, type JsonValue } from "@inkstone/protocol";
import { expect, test as harness } from "./fixtures.js";
import { FAUX_WORKER_CMD, spawnCore } from "./spawnCore.js";

/**
 * External-tool lane, full stack (external-task-views A3/A4): Core seeds the
 * boot-read TickTick credential + the Workflow's `external_tools` flag, ships
 * endpoint+auth in the spawn manifest, the REAL Worker MCP client connects to
 * a fake TickTick MCP server, executes the allowlisted call directly, and the
 * lifecycle frames land in the transcript — rendered as one collapsed
 * name+status row per call that expands to the exact
 * `TranscriptToolResult.content` the model received, identically live and
 * after reload; errors identically; a Stop mid-call settles the row as the
 * Core-generated "interrupted" error.
 */

interface FakeTickTickMcp {
	readonly url: string;
	/** Release every held `tools/call` response (the Stop-mid-call window). */
	release(): void;
	close(): Promise<void>;
}

/** A stateless streamable-HTTP fake of TickTick's MCP service (the S1
 * transport shape): initialize / tools/list / one `filter_tasks` read tool.
 * `hold` parks `tools/call` responses until `release()` so a spec can act
 * while the call is in flight. Empty-args calls fail (`isError: true`) with
 * the S1-pinned single-text-block error shape. */
function startFakeTickTickMcp(
	opts: { hold?: boolean } = {},
): Promise<FakeTickTickMcp> {
	const held: Array<() => void> = [];
	let released = false;
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (req.method !== "POST") {
				res.writeHead(405).end();
				return;
			}
			// `body` is the JSON-RPC request this fake server just received
			// from the Worker's MCP client; the switch below reads only these fields.
			const msg = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: { name?: string; arguments?: JsonObject };
			};
			const respond = (res2: ServerResponse, result: JsonValue) => {
				res2
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
			};
			switch (msg.method) {
				case "initialize":
					respond(res, {
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "fake-ticktick", version: "0.0.0" },
					});
					return;
				case "tools/list":
					// The FULL pinned read allowlist + a write tool: discovery now
					// requires every allowlisted tool before starting (review R12
					// #3), and the write tool pins the filter.
					respond(res, {
						tools: [
							"list_projects",
							"list_tags",
							"filter_tasks",
							"search_task",
							"get_task_by_id",
						]
							.map((name) => ({
								name,
								description: `TickTick ${name}`,
								inputSchema: { type: "object" },
							}))
							.concat([
								{
									name: "create_task",
									description: "WRITE tool — the allowlist must exclude it",
									inputSchema: { type: "object" },
								},
							]),
					});
					return;
				case "tools/call": {
					const args = msg.params?.arguments ?? {};
					const send = () => {
						if (args.filter === undefined) {
							respond(res, {
								content: [
									{ type: "text", text: "Missing required parameter: filter" },
								],
								isError: true,
							});
							return;
						}
						const call = asNumber(args.call);
						const label = call === undefined ? "" : ` #${call}`;
						respond(res, {
							content: [
								{ type: "text", text: `1 task found${label}: S1 timed` },
							],
							structuredContent: { result: [{ title: "S1 timed" }] },
							isError: false,
						});
					};
					if (opts.hold === true && !released) {
						held.push(send);
					} else {
						send();
					}
					return;
				}
				default:
					res.writeHead(202).end();
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			// this server listens on a TCP port, so `address()` is an
			// `AddressInfo` (a string only for a UNIX pipe) inside `listen`.
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}/mcp`,
				release: () => {
					released = true;
					for (const send of held.splice(0)) send();
				},
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

/** The harness `core` fixture rebuilt around a per-test fake MCP server: the
 * server's runtime URL must reach `spawnCore`, which static `test.use`
 * `coreOptions` cannot carry. `mcpHold` parks `tools/call` responses (the
 * Stop-mid-call window) — a server-side behavior, so its own option. */
const test = harness.extend<{ fakeMcp: FakeTickTickMcp; mcpHold: boolean }>({
	mcpHold: [false, { option: true }],
	fakeMcp: async ({ mcpHold }, use) => {
		const fake = await startFakeTickTickMcp({ hold: mcpHold });
		await use(fake);
		await fake.close();
	},
	core: async ({ coreOptions, fakeMcp }, use) => {
		const core = await spawnCore({
			...coreOptions,
			workerCmd: FAUX_WORKER_CMD,
			ticktickMcpUrl: fakeMcp.url,
			fauxExternalCalls: coreOptions.fauxExternalCalls ?? ["ok"],
		});
		await use(core);
		await core.shutdown();
	},
});

test.describe("advanced query", () => {
	test("renders one expandable row whose expansion is identical live and after reload", async ({
		chat,
	}) => {
		await chat.goto();
		await chat.send("how many tasks tomorrow?");

		// The model received the content — its reply echoes it.
		await chat.waitForAssistantText(/external result: 1 task found #1/);

		// One collapsed external row, settled completed.
		const row = chat.page.getByTestId("tool-call");
		await expect(row).toHaveCount(1);
		await expect(row).toHaveAttribute("data-status", "completed");
		await expect(row).toHaveAttribute("data-external", "true");
		await expect(row).toContainText("TickTick · filter tasks");
		await expect(chat.page.getByTestId("tool-call-result")).toHaveCount(0);

		// Expand: the exact model-received content.
		await row.getByRole("button").click();
		const liveExpansion = chat.page.getByTestId("tool-call-result");
		await expect(liveExpansion).toHaveText("1 task found #1: S1 timed");
		// Never exposed: raw MCP metadata (the structuredContent sidecar).
		await expect(liveExpansion).not.toContainText("structuredContent");

		// Cold reload: the row + its expansion rehydrate identically.
		await chat.reload();
		const reloadedRow = chat.page.getByTestId("tool-call");
		await expect(reloadedRow).toHaveCount(1);
		await expect(reloadedRow).toHaveAttribute("data-status", "completed");
		await reloadedRow.getByRole("button").click();
		await expect(chat.page.getByTestId("tool-call-result")).toHaveText(
			"1 task found #1: S1 timed",
		);
	});
});

test.describe("two same-name calls", () => {
	test.use({ coreOptions: { fauxExternalCalls: ["ok", "ok"] } });

	test("render as two rows with distinct results, live and reloaded", async ({
		chat,
	}) => {
		await chat.goto();
		await chat.send("check twice");
		await chat.waitForAssistantText(/external result: 1 task found #2/);

		const assertTwoDistinctRows = async () => {
			const rows = chat.page.getByTestId("tool-call");
			await expect(rows).toHaveCount(2);
			await rows.nth(0).getByRole("button").click();
			await rows.nth(1).getByRole("button").click();
			const expansions = chat.page.getByTestId("tool-call-result");
			await expect(expansions).toHaveCount(2);
			await expect(expansions.nth(0)).toHaveText("1 task found #1: S1 timed");
			await expect(expansions.nth(1)).toHaveText("1 task found #2: S1 timed");
		};

		await assertTwoDistinctRows();
		await chat.reload();
		await assertTwoDistinctRows();
	});
});

test.describe("failed call", () => {
	test.use({ coreOptions: { fauxExternalCalls: ["error"] } });

	test("renders an error row that expands to the error content, identically after reload", async ({
		chat,
	}) => {
		await chat.goto();
		await chat.send("bad query");
		await chat.waitForAssistantText(/external result: Missing required/);

		const assertErrorRow = async () => {
			const row = chat.page.getByTestId("tool-call");
			await expect(row).toHaveAttribute("data-status", "error");
			await expect(row).toContainText("failed");
			await row.getByRole("button").click();
			await expect(chat.page.getByTestId("tool-call-result")).toHaveText(
				"Missing required parameter: filter",
			);
		};

		await assertErrorRow();
		await chat.reload();
		await assertErrorRow();
	});
});

test.describe("stop mid-call", () => {
	test.use({ mcpHold: true });

	test("settles the row as the Core-generated interrupted error, identically after reload", async ({
		chat,
		fakeMcp,
	}) => {
		await chat.goto();
		await chat.send("query that hangs");

		// The call is in flight: a running external row.
		const row = chat.page.getByTestId("tool-call");
		await expect(row).toHaveAttribute("data-status", "running", {
			timeout: 15_000,
		});

		// Stop while the MCP call is held open: the cancel transition settles the
		// pending row and publishes interrupted → cancelled, in that order.
		await chat.stop();

		const assertInterrupted = async () => {
			const settled = chat.page.getByTestId("tool-call");
			await expect(settled).toHaveAttribute("data-status", "error", {
				timeout: 15_000,
			});
			await settled.getByRole("button").click();
			await expect(chat.page.getByTestId("tool-call-result")).toHaveText(
				"interrupted",
			);
		};
		await assertInterrupted();
		// A deliberate Stop is calm (ADR-0014), not a failure alert.
		await expect(chat.assistantStopped()).toBeVisible();

		await chat.reload();
		await assertInterrupted();

		// Unstick the held response so shutdown is not left waiting on it.
		fakeMcp.release();
	});
});
