import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	adaptMcpResult,
	buildExternalTools,
	callExternalTool,
	EXTERNAL_READ_ALLOWLIST,
} from "../src/external-tools.js";
import { fauxInterpreterDeps } from "../src/faux/faux-deps.js";
import { runInterpreter } from "../src/interpreter.js";
import type { WorkerEmit } from "../src/transport.js";
import { InMemoryTransport } from "../src/transport-memory.js";

// External-tool lane tests (external-task-views A3/A4): the dual read
// allowlist, the MCP→transcript adapter, and the lifecycle frames — driven
// end-to-end through the REAL interpreter + MCP SDK client against an
// in-process fake TickTick MCP server (stateless streamable HTTP).

/** The approved tool surface: the five read tools the allowlist admits plus a
 * write tool and an extra read tool it must exclude. */
const SERVER_TOOLS = [
	...EXTERNAL_READ_ALLOWLIST.map((name) => ({
		name,
		description: `TickTick ${name}`,
		inputSchema: { type: "object" as const },
	})),
	{
		name: "create_task",
		description: "WRITE tool — must never be exposed",
		inputSchema: { type: "object" as const },
	},
	{
		name: "list_habits",
		description: "read tool outside the exact allowlist",
		inputSchema: { type: "object" as const },
	},
];

interface FakeCall {
	name: string;
	args: unknown;
}

/** A minimal stateless streamable-HTTP MCP server: initialize / initialized /
 * tools/list / tools/call over plain JSON POST responses. Records every call +
 * authorization header for assertions. */
function startFakeMcp(
	onCall: (call: FakeCall) => {
		content: unknown[];
		isError?: boolean;
		structuredContent?: unknown;
	},
): Promise<{
	url: string;
	calls: FakeCall[];
	authorizations: string[];
	close: () => Promise<void>;
}> {
	const calls: FakeCall[] = [];
	const authorizations: string[] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			authorizations.push(String(req.headers.authorization ?? ""));
			if (req.method !== "POST") {
				// The SDK may probe GET (server-push SSE) — not offered here.
				res.writeHead(405).end();
				return;
			}
			const msg = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: { name?: string; arguments?: unknown };
			};
			const respond = (result: unknown) => {
				res
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
			};
			switch (msg.method) {
				case "initialize":
					respond({
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "fake-ticktick", version: "0.0.0" },
					});
					return;
				case "tools/list":
					respond({ tools: SERVER_TOOLS });
					return;
				case "tools/call": {
					const call = {
						name: msg.params?.name ?? "",
						args: msg.params?.arguments,
					};
					calls.push(call);
					respond(onCall(call));
					return;
				}
				default:
					// notifications (e.g. initialized) take a 202 ack.
					res.writeHead(202).end();
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}/mcp`,
				calls,
				authorizations,
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

function externalManifest(url: string): WorkerManifest {
	return {
		run_id: "01900000-0000-7000-8000-00000000ext1",
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: "faux",
			model: "faux-1",
			system_prompt: "You are a test assistant.",
			thinking_level: "off",
			tools: [],
		},
		prompt: "how many tasks tomorrow?",
		messages: [],
		external_tools: { endpoint: url, access_token: "tok_test" },
	};
}

describe("adaptMcpResult", () => {
	it("copies text content verbatim, drops structuredContent and non-text blocks", () => {
		const adapted = adaptMcpResult({
			content: [
				{ type: "text", text: "1 task found: Timed task" },
				{ type: "image", data: "…", mimeType: "image/png" },
			],
			structuredContent: { result: [{ title: "Timed task" }] },
			isError: false,
		});
		expect(adapted).toEqual({
			content: [{ type: "text", text: "1 task found: Timed task" }],
			isError: false,
		});
	});

	it("maps isError === true and defaults anything else to false", () => {
		expect(
			adaptMcpResult({
				content: [{ type: "text", text: "boom" }],
				isError: true,
			}).isError,
		).toBe(true);
		expect(adaptMcpResult({ content: [] }).isError).toBe(false);
		expect(adaptMcpResult("garbage").isError).toBe(false);
	});
});

describe("dual read-allowlist", () => {
	it("pins the exact five read tools", () => {
		expect(EXTERNAL_READ_ALLOWLIST).toEqual([
			"list_projects",
			"list_tags",
			"filter_tasks",
			"search_task",
			"get_task_by_id",
		]);
	});

	it("gate #1: discovery filters to the allowlist, namespaced for the model", () => {
		const tools = buildExternalTools(
			{ callTool: () => Promise.resolve({ content: [] }) },
			SERVER_TOOLS,
		);
		expect(tools.map((t) => t.name)).toEqual([
			"ticktick_list_projects",
			"ticktick_list_tags",
			"ticktick_filter_tasks",
			"ticktick_search_task",
			"ticktick_get_task_by_id",
		]);
		expect(tools.some((t) => t.name.includes("create_task"))).toBe(false);
	});

	it("gate #2: the executor rejects a non-allowlisted tool BEFORE calling the server", async () => {
		const calls: FakeCall[] = [];
		const caller = {
			callTool: (params: {
				name: string;
				arguments: Record<string, unknown>;
			}) => {
				calls.push({ name: params.name, args: params.arguments });
				return Promise.resolve({ content: [] });
			},
		};
		await expect(callExternalTool(caller, "create_task", {})).rejects.toThrow(
			/not in the read allowlist/,
		);
		expect(calls).toEqual([]);
	});
});

describe("interpreter with external tools (fake MCP server)", () => {
	async function runExternalChat(
		onCall: Parameters<typeof startFakeMcp>[0],
		responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
	) {
		const fake = await startFakeMcp(onCall);
		cleanup = fake.close;
		const faux = fauxProvider({ provider: "faux" });
		faux.setResponses(responses);
		const events: WorkerEmit[] = [];
		const requests: { toolCallId: string; name: string; params: unknown }[] =
			[];
		await Effect.runPromise(
			runInterpreter(
				externalManifest(fake.url),
				fauxInterpreterDeps(faux),
			).pipe(
				Effect.provide(InMemoryTransport(events, { results: {}, requests })),
			),
		);
		return { fake, events, requests };
	}

	it("emits started/finished frames from pi's events; no Tool Protocol round-trip", async () => {
		const { fake, events, requests } = await runExternalChat(
			() => ({
				content: [{ type: "text", text: "1 task found: S1 timed" }],
				structuredContent: { result: [{ title: "S1 timed" }] },
				isError: false,
			}),
			[
				fauxAssistantMessage(
					[
						fauxToolCall(
							"ticktick_filter_tasks",
							{ filter: { status: [0] } },
							{ id: "tc_ext_1" },
						),
					],
					{ stopReason: "toolUse" },
				),
				(context) => {
					const result = [...context.messages]
						.reverse()
						.find((m) => m.role === "toolResult");
					const text =
						result && Array.isArray(result.content)
							? result.content.map((c) => ("text" in c ? c.text : "")).join("")
							: "";
					return fauxAssistantMessage(`answer: ${text}`);
				},
			],
		);

		// The lifecycle frames, in order, sourced from pi's tool events (A4).
		const frames = events.filter(
			(e) =>
				e.kind === "external_tool_started" ||
				e.kind === "external_tool_finished",
		);
		expect(frames).toEqual([
			{
				kind: "external_tool_started",
				tool_call_id: "tc_ext_1",
				name: "ticktick_filter_tasks",
				arguments: { filter: { status: [0] } },
			},
			{
				kind: "external_tool_finished",
				tool_call_id: "tc_ext_1",
				result: {
					content: [{ type: "text", text: "1 task found: S1 timed" }],
					is_error: false,
				},
			},
		]);
		// Direct execution: the server saw the call; Core saw NO tool_request.
		expect(fake.calls).toEqual([
			{ name: "filter_tasks", args: { filter: { status: [0] } } },
		]);
		expect(requests).toEqual([]);
		// The Bearer token reached the server on every request.
		expect(new Set(fake.authorizations)).toEqual(new Set(["Bearer tok_test"]));
		// The model actually received the content (its reply echoes it).
		const text = events
			.filter(
				(e): e is { kind: "text_delta"; delta: string } =>
					e.kind === "text_delta",
			)
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("answer: 1 task found: S1 timed");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("a failed MCP call finishes with is_error: true and an error transcript", async () => {
		let sawIsError: boolean | undefined;
		const { events } = await runExternalChat(
			() => ({
				content: [{ type: "text", text: "Missing required parameter: filter" }],
				isError: true,
			}),
			[
				fauxAssistantMessage(
					[fauxToolCall("ticktick_filter_tasks", {}, { id: "tc_err" })],
					{ stopReason: "toolUse" },
				),
				(context) => {
					const result = [...context.messages]
						.reverse()
						.find((m) => m.role === "toolResult");
					sawIsError = (result as { isError?: boolean } | undefined)?.isError;
					return fauxAssistantMessage("noted the failure");
				},
			],
		);

		const finished = events.find((e) => e.kind === "external_tool_finished");
		expect(finished).toEqual({
			kind: "external_tool_finished",
			tool_call_id: "tc_err",
			result: {
				content: [{ type: "text", text: "Missing required parameter: filter" }],
				is_error: true,
			},
		});
		// pi's transcript carries the error flag too (afterToolCall lifted it).
		expect(sawIsError).toBe(true);
	});

	it("a two-call batch emits start/finish pairs in source order (sequential mode)", async () => {
		const { events } = await runExternalChat(
			(call) => ({
				content: [{ type: "text", text: `result of ${call.name}` }],
				isError: false,
			}),
			[
				fauxAssistantMessage(
					[
						fauxToolCall(
							"ticktick_search_task",
							{ query: "a" },
							{ id: "tc_a" },
						),
						fauxToolCall(
							"ticktick_search_task",
							{ query: "b" },
							{ id: "tc_b" },
						),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("both done"),
			],
		);

		const frameOrder = events
			.filter(
				(e) =>
					e.kind === "external_tool_started" ||
					e.kind === "external_tool_finished",
			)
			.map(
				(e) =>
					`${e.kind === "external_tool_started" ? "start" : "end"}:${e.tool_call_id}`,
			);
		expect(frameOrder).toEqual([
			"start:tc_a",
			"end:tc_a",
			"start:tc_b",
			"end:tc_b",
		]);
	});

	it("a connect failure rejects (worker-main maps it to the terminal error)", async () => {
		const faux = fauxProvider({ provider: "faux" });
		faux.setResponses([fauxAssistantMessage("never reached")]);
		const events: WorkerEmit[] = [];
		// A closed port: nothing listens.
		const manifest = externalManifest("http://127.0.0.1:9/mcp");
		await expect(
			Effect.runPromise(
				runInterpreter(manifest, fauxInterpreterDeps(faux)).pipe(
					Effect.provide(InMemoryTransport(events)),
				),
			),
		).rejects.toThrow();
		expect(events.some((e) => e.kind === "done")).toBe(false);
	});
});
