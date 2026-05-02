/**
 * One-liner renderers for tool call args. Rendering contract between the
 * backend (which owns the tool vocabulary) and any frontend (which paints
 * `ToolPart` rows). Lives in `bridge/` so neither layer has to reach
 * across the boundary to pick up display knowledge.
 *
 * Design:
 *   - Each entry narrows `unknown` locally via property checks, so the
 *     map value type is `(args: unknown) => string`. pi-ai's
 *     `ToolCall.arguments` is `Record<string, any>`.
 *   - Unknown tool name → no args rendering (`ToolPart` shows just the
 *     tool name). Intentional: the only way to hit the empty path is to
 *     add a tool without adding a renderer, and an empty string nudges
 *     the contributor to supply one.
 *   - The 80-char cap lives here so the fallback and per-tool cases
 *     share a single truncation policy.
 *   - Outputs are always passed through `stripAnsi` before truncation.
 *     The LLM is an untrusted source — args can carry ANSI escape
 *     sequences that the `<text>` renderable would interpret (e.g.
 *     `\x1b[2J` clears the screen). `<markdown>` neutralizes this at
 *     the parser level; the `<text>`-based `ToolPart` path doesn't.
 *     Closes the M4 hazard from the May 2026 audit.
 */

import { stripAnsi } from "./ansi";

const MAX_LEN = 80;

function trunc(s: string, limit = MAX_LEN): string {
	const clean = stripAnsi(s);
	if (clean.length <= limit) return clean;
	return `${clean.slice(0, limit - 1)}…`;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function arr(v: unknown): unknown[] | undefined {
	return Array.isArray(v) ? v : undefined;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}

export type ToolArgRenderer = (args: unknown) => string;

/**
 * Map of tool names to arg-rendering functions. Keyed on pi-ai's
 * tool name (the string the LLM sees), not a display label.
 *
 * Add new tools here alongside their definition in
 * `backend/agent/tools.ts` so the display contract stays co-located
 * with the tool vocabulary across the layer boundary.
 */
export const TOOL_ARG_RENDERERS: Record<string, ToolArgRenderer> = {
	read(args) {
		const o = asObj(args) ?? {};
		const path = str(o.path) ?? str(o.filePath) ?? "";
		return trunc(path);
	},
	write(args) {
		const o = asObj(args) ?? {};
		const path = str(o.path) ?? str(o.filePath) ?? "";
		return trunc(path);
	},
	edit(args) {
		const o = asObj(args) ?? {};
		const path = str(o.path) ?? str(o.filePath) ?? "";
		const edits = arr(o.edits);
		const count = edits?.length ?? 1;
		return trunc(`${path} (${count} edit${count === 1 ? "" : "s"})`);
	},
	update_sidebar(args) {
		const o = asObj(args) ?? {};
		const op = str(o.operation) ?? "";
		const id = str(o.id) ?? "";
		return trunc(`${op} "${id}"`);
	},
};

/**
 * Render the args row that follows the tool name in the inline label.
 * Unknown tool → empty string (renderer missing is a contributor
 * signal, not a runtime concern).
 */
export function renderToolArgs(name: string, args: unknown): string {
	const renderer = TOOL_ARG_RENDERERS[name];
	return renderer ? renderer(args) : "";
}
