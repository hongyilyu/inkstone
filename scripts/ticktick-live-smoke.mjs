// Live TickTick MCP contract smoke — the Worker-lane half of the credentialed
// validation the plan pins (docs/plans/external-task-views-plan.md). The Web
// lane (OpenAPI) is smoked through the PRODUCTION Rust decoder instead —
// crates/core/src/ticktick/client.rs `live_openapi_contract_smoke` (review R10
// #3) — so nothing here mirrors wire.rs. This script asserts only that the live
// MCP service still initializes and offers every tool in the Worker's exact
// read allowlist. NON-CAPTURING: prints counts/booleans only — no response
// body, no header value, and never the token; even parse failures rethrow
// static lane-named messages (a raw SyntaxError quotes its input).
//
// Requires TICKTICK_ACCESS_TOKEN (full scope — S1: MCP rejects tasks:read).

const MCP_URL = "https://mcp.ticktick.com/";
const MCP_PROTOCOL_VERSION = "2025-06-18";

// The Worker's exact read allowlist (packages/worker/src/external-tools.ts
// EXTERNAL_READ_ALLOWLIST). Deliberately re-spelled here: the smoke asserts the
// LIVE server still offers these names, independent of the code that filters on
// them — deriving one from the other would hide exactly the drift this detects.
const ALLOWLIST = [
	"list_projects",
	"list_tags",
	"filter_tasks",
	"search_task",
	"get_task_by_id",
];

const token = process.env.TICKTICK_ACCESS_TOKEN;
if (!token) {
	console.error(
		"TICKTICK_ACCESS_TOKEN is not set (repo secret; full-scope token)",
	);
	process.exit(1);
}

/** Fetch with the bearer + a bound; non-2xx throws with the STATUS only (never
 * the body — it could carry account data). */
async function request(url, init = {}) {
	const response = await fetch(url, {
		...init,
		headers: {
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...init.headers,
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(
			`${init.method ?? "GET"} ${new URL(url).pathname}: HTTP ${response.status}`,
		);
	}
	return response;
}

/** JSON.parse whose failure names the lane only — a raw SyntaxError message
 * quotes a prefix of its input, which would put response content into the
 * public workflow log (CodeRabbit #336). */
function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("mcp: response is not valid JSON");
	}
}

/** Parse an MCP response body: plain JSON or an SSE stream. Spec-conformant
 * enough for a smoke (review R12 #7): line breaks may be CRLF/CR/LF (normalize
 * first), an event's `data` is every `data:` line joined WITH `\n` (the spec's
 * mandated joiner — concatenating loses multiline JSON), and the optional
 * single space after the colon is stripped (`data:x` and `data: x` are equal). */
async function mcpBody(response) {
	const text = await response.text();
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream")) {
		return parseJson(text);
	}
	const messages = [];
	const normalized = text.replace(/\r\n|\r/g, "\n");
	for (const block of normalized.split("\n\n")) {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data) messages.push(parseJson(data));
	}
	return messages.length === 1 ? messages[0] : messages;
}

async function mcpLane() {
	// initialize → session id → notifications/initialized → tools/list (paged).
	let nextId = 1;
	let sessionId = null;
	const send = async (method, params, notification = false) => {
		const headers = { "mcp-protocol-version": MCP_PROTOCOL_VERSION };
		if (sessionId) headers["mcp-session-id"] = sessionId;
		const response = await request(MCP_URL, {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				...(notification ? {} : { id: nextId++ }),
				method,
				...(params === undefined ? {} : { params }),
			}),
		});
		sessionId = response.headers.get("mcp-session-id") ?? sessionId;
		if (notification) return null;
		const body = await mcpBody(response);
		const messages = Array.isArray(body) ? body : [body];
		const reply = messages.find((m) => m?.id === nextId - 1);
		if (!reply) throw new Error(`${method}: no JSON-RPC reply`);
		if (reply.error) throw new Error(`${method}: JSON-RPC ${reply.error.code}`);
		return reply;
	};

	await send("initialize", {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "inkstone-live-smoke", version: "0.0.0" },
	});
	await send("notifications/initialized", undefined, true);

	const names = [];
	let cursor;
	do {
		const reply = await send("tools/list", cursor ? { cursor } : {});
		names.push(...(reply.result?.tools ?? []).map((tool) => tool.name));
		cursor = reply.result?.nextCursor;
	} while (cursor);

	const missing = ALLOWLIST.filter((name) => !names.includes(name));
	if (missing.length > 0) {
		throw new Error(
			`MCP tools/list no longer offers allowlisted tool(s): ${missing.join(", ")}`,
		);
	}
	console.log(
		`mcp: ok (tools=${names.length}, allowlist_present=${ALLOWLIST.length}/${ALLOWLIST.length})`,
	);
}

try {
	await mcpLane();
	console.log("mcp live smoke: PASS");
} catch (error) {
	console.error(`mcp live smoke: FAIL — ${error.message}`);
	process.exit(1);
}
