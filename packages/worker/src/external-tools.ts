import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentEvent,
	AgentTool,
	AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type {
	ExternalToolFinished,
	ExternalToolStarted,
	JsonObject,
	JsonValue,
	WorkerManifest,
} from "@inkstone/protocol";
import {
	asArray,
	asObject,
	decodeJson,
	EXTERNAL_TOOL_PREFIX,
	isExternalToolName,
} from "@inkstone/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Option } from "effect";

// External (Worker-executed MCP) tools — external-task-views A3/A4. The Worker
// connects DIRECTLY to TickTick's official MCP service (manifest-passed
// endpoint + auth), discovers once per spawn, and exposes ONLY the exact read
// allowlist below — applied twice (discovery filter + pre-execution gate).
// Server annotations/schema-hiding are never the safety mechanism, and there is
// no server-enforced read-only credential (S1: MCP demands `tasks:write`).

/** The exact approved read allowlist: list/tag discovery, advanced server-side
 * filtering, keyword search, and detail lookup. No
 * create/update/complete/move/assign/comment-write/delete tool is ever exposed
 * or executed. */
export const EXTERNAL_READ_ALLOWLIST: readonly string[] = [
	"list_projects",
	"list_tags",
	"filter_tasks",
	"search_task",
	"get_task_by_id",
];

/** The details sidecar the external executor attaches so the interpreter's
 * `afterToolCall` can carry the MCP result's own `isError` into pi's error flag
 * (pi tools otherwise signal errors only by throwing). Worker-runtime only —
 * dropped at the frame boundary, never durable. */
export interface ExternalCallDetails {
	external_is_error: boolean;
}

/** One MCP content block we forward: text-only, matching the S1 adapter
 * contract (copy `result.content` verbatim, keep `type:"text"` blocks). */
interface McpTextBlock {
	type: "text";
	text: string;
}

/** Narrow a result's `content` to the text blocks we forward, COERCING each
 * `text` via `String(...)` so a spec-loose server's non-string `text` can never
 * leak through unstringified. The ONE text-block narrowing both `adaptMcpResult`
 * and `externalFrameFor` use — previously the finished-frame mapping re-did it
 * inline with a weaker (unchecked) guard (review M3). */
function narrowTextBlocks(content: JsonValue | undefined): McpTextBlock[] {
	return asArray(content).flatMap((block): McpTextBlock[] => {
		const record = asObject(block);
		return record?.type === "text"
			? [{ type: "text", text: String(record.text) }]
			: [];
	});
}

/** Adapt an MCP `tools/call` result to the model-visible content: copy the text
 * blocks of `result.content` verbatim; DROP the duplicate `structuredContent`
 * sidecar and every transport detail. Exported for the adapter unit tests. */
export function adaptMcpResult(result: JsonValue) {
	const record = asObject(result);
	return {
		content: narrowTextBlocks(record?.content),
		isError: record?.isError === true,
	};
}

/** Map a pi tool-execution event to the external-call lifecycle frame it emits,
 * or `undefined` for any non-external event (external-task-views A4). ONLY
 * `ticktick_*` calls emit frames — Core-proxied tools reach Core through the
 * Tool Protocol round-trip. The finished frame copies the FINALIZED result's
 * text blocks through the shared `narrowTextBlocks` (review M3); the error flag
 * lives once, inside the result. Lives here beside the seam it belongs to, not
 * inline in `runInterpreter`. */
export function externalFrameFor(
	event: AgentEvent,
): ExternalToolStarted | ExternalToolFinished | undefined {
	if (
		event.type === "tool_execution_start" &&
		isExternalToolName(event.toolName)
	) {
		return {
			kind: "external_tool_started",
			tool_call_id: event.toolCallId,
			name: event.toolName,
			arguments: event.args,
		};
	}
	if (
		event.type === "tool_execution_end" &&
		isExternalToolName(event.toolName)
	) {
		return {
			kind: "external_tool_finished",
			tool_call_id: event.toolCallId,
			result: {
				content: narrowTextBlocks(event.result?.content),
				is_error: event.isError,
			},
		};
	}
	return undefined;
}

/** pi `afterToolCall` hook: lift an external MCP result's own `isError` (carried
 * in `details`, since pi tools otherwise signal errors only by throwing) into
 * pi's error flag. Core tools and clean external results pass through untouched.
 * Async to match pi's `afterToolCall` signature (review M3). */
export async function liftExternalIsError(
	ctx: AfterToolCallContext,
): Promise<AfterToolCallResult | undefined> {
	return isExternalToolName(ctx.toolCall.name) &&
		asObject(ctx.result.details)?.external_is_error === true
		? { isError: true }
		: undefined;
}

/** The slice of the MCP client the executor needs — a seam so the gate +
 * adapter are testable against a fake without a live connection. The result is
 * the wire truth (JSON), NOT a protocol-revision-specific result type; the
 * adapter narrows the content blocks it forwards. */
export interface ExternalCaller {
	callTool(
		params: {
			name: string;
			arguments: JsonObject;
		},
		resultSchema?: undefined,
		options?: { timeout?: number },
	): Promise<JsonValue>;
}

/** The MCP `Client` behind the {@link ExternalCaller} seam: its result crosses as
 * decoded JSON, which `adaptMcpResult` then narrows. */
const mcpCaller = (client: Client): ExternalCaller => ({
	callTool: async (params, _resultSchema, options) =>
		Option.getOrNull(
			decodeJson(await client.callTool(params, undefined, options)),
		),
});

interface DiscoveredExternalTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: unknown;
}

export interface ExternalDiscoveryCaller {
	listTools(
		params?: { cursor?: string },
		options?: { timeout?: number },
	): Promise<{
		tools: DiscoveredExternalTool[];
		nextCursor?: string;
	}>;
}

/** A corrupt server must not keep a Worker in discovery forever even if every
 * cursor is unique. This is deliberately far above the five-tool expected
 * surface while still giving the loop a hard end. */
const EXTERNAL_DISCOVERY_PAGE_LIMIT = 100;

/** Execute one allowlisted external call: gate #2 (the exact allowlist again,
 * immediately before execution — defense in depth on top of the discovery
 * filter), then the server call, then the adapter. The MCP result's own
 * `isError` rides `details` for the interpreter's `afterToolCall` to lift into
 * pi's error flag. */
export async function callExternalTool(
	caller: ExternalCaller,
	serverName: string,
	params: JsonValue,
	timeoutMs: number,
): Promise<AgentToolResult<ExternalCallDetails>> {
	if (!EXTERNAL_READ_ALLOWLIST.includes(serverName)) {
		throw new Error(`external tool ${serverName} is not in the read allowlist`);
	}
	const result = await caller.callTool(
		{
			name: serverName,
			arguments: asObject(params) ?? {},
		},
		undefined,
		{ timeout: timeoutMs },
	);
	const adapted = adaptMcpResult(result);
	return {
		content: adapted.content,
		details: { external_is_error: adapted.isError },
	};
}

/** Discover every page under one timeout policy. Repeated cursors fail before
 * another request; endlessly unique cursors hit a finite page ceiling. */
export async function discoverExternalTools(
	caller: ExternalDiscoveryCaller,
	timeoutMs: number,
): Promise<DiscoveredExternalTool[]> {
	const discovered: DiscoveredExternalTool[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	for (
		let pageNumber = 0;
		pageNumber < EXTERNAL_DISCOVERY_PAGE_LIMIT;
		pageNumber++
	) {
		const page = await caller.listTools(
			cursor === undefined ? undefined : { cursor },
			{ timeout: timeoutMs },
		);
		discovered.push(...page.tools);

		const nextCursor = page.nextCursor;
		if (nextCursor === undefined) return discovered;
		if (seenCursors.has(nextCursor)) {
			throw new Error("MCP discovery returned a repeated cursor");
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}

	throw new Error(
		`MCP discovery exceeded the ${EXTERNAL_DISCOVERY_PAGE_LIMIT}-page limit`,
	);
}

/** Build the namespaced `AgentTool`s from a discovered tool list: gate #1 —
 * only the exact allowlisted names survive, so the model never sees a write
 * tool's schema. Exported for the discovery-filter unit tests. */
export function buildExternalTools(
	caller: ExternalCaller,
	discovered: ReadonlyArray<DiscoveredExternalTool>,
	timeoutMs: number,
): AgentTool[] {
	return discovered
		.filter((tool) => EXTERNAL_READ_ALLOWLIST.includes(tool.name))
		.map((tool): AgentTool => {
			const serverName = tool.name;
			return {
				name: `${EXTERNAL_TOOL_PREFIX}${serverName}`,
				description: tool.description ?? "",
				label: `TickTick ${serverName.replaceAll("_", " ")}`,
				// the MCP server advertises `inputSchema` as an untyped JSON
				// Schema object, which is what pi's `parameters` slot consumes — no
				// shared type spans the two SDKs.
				parameters: tool.inputSchema as AgentTool["parameters"],
				execute: (_toolCallId, params) =>
					callExternalTool(
						caller,
						serverName,
						Option.getOrNull(decodeJson(params)),
						timeoutMs,
					),
			};
		});
}

/** Connect to the manifest's MCP endpoint, discover its tools ONCE per spawn,
 * and build the allowlisted, namespaced `AgentTool`s. Returns the tools plus a
 * `close` for the interpreter's end-of-run cleanup. A connect/discovery
 * failure rejects — worker-main converts it into the Run's terminal `error`
 * event (the Workflow opted into external tools; a broken dependency fails
 * loud, not silently tool-less). */
export async function connectExternalTools(
	config: NonNullable<WorkerManifest["external_tools"]>,
): Promise<{ tools: AgentTool[]; close: () => Promise<void> }> {
	const client = new Client({ name: "inkstone-worker", version: "0.0.0" });
	const transport = new StreamableHTTPClientTransport(
		new URL(config.endpoint),
		{
			requestInit: {
				headers: { authorization: `Bearer ${config.access_token}` },
			},
		},
	);
	try {
		await client.connect(transport, { timeout: config.timeout_ms });
		const discovered = await discoverExternalTools(client, config.timeout_ms);

		const names = discovered.map((tool) => tool.name);
		if (new Set(names).size !== names.length) {
			throw new Error("MCP discovery returned duplicate tool names");
		}
		const tools = buildExternalTools(
			mcpCaller(client),
			discovered,
			config.timeout_ms,
		);
		if (tools.length !== EXTERNAL_READ_ALLOWLIST.length) {
			const offered = new Set(names);
			const missing = EXTERNAL_READ_ALLOWLIST.filter(
				(name) => !offered.has(name),
			);
			throw new Error(
				`MCP discovery is missing allowlisted tool(s): ${missing.join(", ")}`,
			);
		}

		return {
			tools,
			close: () => client.close(),
		};
	} catch (error) {
		// The caller never receives `close` on any connect/discovery/validation
		// failure, so this branch owns cleanup for all of them.
		await client.close().catch(() => undefined);
		throw error;
	}
}
