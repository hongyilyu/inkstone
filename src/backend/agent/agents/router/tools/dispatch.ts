/**
 * `dispatch` — the router's only tool.
 *
 * Per ADR 0007 the router classifies the user's freeform first message
 * by calling `dispatch({ agent })` exactly once. The tool is a pure
 * classifier: `execute()` returns the chosen agent name as `details`
 * and sets `terminate: true` so pi-agent-core seals the router's turn
 * (per Q5 in the grilling design tree — one-shot, sealed after dispatch).
 *
 * The fork itself happens TUI-side in `applyDispatchResult` (the
 * reducer's `tool_execution_end` handler), mirroring how `update_sidebar`
 * splits the LLM-facing tool call from the side-effect handler. Two
 * reasons:
 *   1. The fork needs `store.messages[0]` (the user's seed message) and
 *      the matching `AgentMessage` from `messageLog` — both live in the
 *      TUI process. Calling `forkSession()` from the tool would require
 *      shipping that state into the agent loop, which is a layering
 *      inversion.
 *   2. The TUI also needs to abort the in-flight router turn and resume
 *      into the child session immediately after dispatch — actions that
 *      only the TUI process can take.
 *
 * Schema: `agent` is a typebox-literal-union over the registry minus
 * the router. The enum is built lazily on first `parameters` access via
 * a defineProperty getter — the static-circular `agents.ts` ↔ `dispatch
 * .ts` import (agents.ts puts `routerAgent` in its registry literal;
 * routerAgent's `extraTools` references `dispatchTool`; dispatch's
 * schema needs `AGENTS`) means the enum can't be built at module load.
 * pi-agent-core reads `tool.parameters` at session construction (when
 * `composeTools` runs), well after all module evaluation completes —
 * so the lazy getter resolves cleanly. The enum on the schema lets
 * provider-side structured-output enforcement reject invalid targets
 * upstream of `execute()`.
 */
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type TSchema, Type } from "typebox";
import { AGENTS } from "../../../agents";
import type { InkstoneTool } from "../../../types";

let cachedSchema: TSchema | null = null;

function buildDispatchSchema(): TSchema {
	if (cachedSchema) return cachedSchema;
	const targetNames = AGENTS.filter((a) => a.name !== "router").map(
		(a) => a.name,
	);
	const literals = targetNames.map((n) => Type.Literal(n));
	// `Type.Union([x])` rejects a single-member union; use the literal
	// directly. Empty registry (no non-router agents) falls back to
	// `Type.String()` so the tool stays schema-valid — composeTools
	// would still register the router but no dispatch is possible.
	let agentField: TSchema;
	if (literals.length === 0) {
		agentField = Type.String({
			description: "No target agents registered.",
		});
	} else if (literals.length === 1) {
		// biome-ignore lint/style/noNonNullAssertion: length === 1 guard above
		agentField = literals[0]!;
	} else {
		agentField = Type.Union(literals);
	}
	cachedSchema = Type.Object({
		agent: {
			...agentField,
			description:
				"The target agent name to route this message to. Must be one " +
				"of the values in the enum.",
		},
	});
	return cachedSchema;
}

export type DispatchInput = { agent: string };

/**
 * Details payload carried on `tool_execution_end` so the TUI reducer
 * can fork into the chosen child session.
 */
export interface DispatchDetails {
	agent: string;
}

const dispatchToolBase: Omit<
	InkstoneTool<TSchema, DispatchDetails>,
	"parameters"
> = {
	name: "dispatch",
	baseline: [],
	label: "Dispatch",
	description:
		"Route this freeform message to the chosen target agent. Call " +
		"this exactly once with the best-matching agent's name.",
	async execute(
		_callId: string,
		params: DispatchInput,
	): Promise<AgentToolResult<DispatchDetails>> {
		const target = AGENTS.find((a) => a.name === params.agent);
		if (!target || params.agent === "router") {
			const valid = AGENTS.filter((a) => a.name !== "router")
				.map((a) => a.name)
				.join(", ");
			throw new Error(
				`dispatch: unknown agent '${params.agent}'. Valid: ${valid}`,
			);
		}
		return {
			content: [{ type: "text", text: `→ ${params.agent}` }],
			details: { agent: params.agent },
			// Seal the router's turn (per ADR 0007 / grilling Q5).
			terminate: true,
		};
	},
};

// Lazy `parameters` accessor — evaluated on first read by
// `composeTools` at session construction, after all module loads
// complete. Caches via `cachedSchema` so subsequent reads return the
// same object reference (pi-agent-core treats identity as a stability
// signal in some downstream code paths).
export const dispatchTool: InkstoneTool<TSchema, DispatchDetails> =
	Object.defineProperty(
		dispatchToolBase as InkstoneTool<TSchema, DispatchDetails>,
		"parameters",
		{
			get: buildDispatchSchema,
			enumerable: true,
		},
	);
