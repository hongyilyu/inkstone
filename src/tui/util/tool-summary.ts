/**
 * One-liner summaries for `DisplayPart` tool entries. Keeps the
 * `ToolPart` renderer free of per-tool dispatch.
 *
 * Design: `name` is pi-ai's tool name (the string the LLM sees, not a
 * display label). New tools either (a) add a case here, or (b) fall
 * through to `generic()`, which truncates the args JSON.
 *
 * `args` is typed `unknown` because pi-ai's `ToolCall.arguments` is
 * `Record<string, any>` — each case narrows locally with property
 * checks before rendering.
 *
 * Outputs are always passed through `stripAnsi` before truncation.
 * The LLM is an untrusted source — it can emit args containing ANSI
 * escape sequences that would otherwise be interpreted by the
 * terminal when the ToolPart renderer writes them as plain `<text>`
 * (not `<markdown>`, which neutralizes them). Closes the M4 hazard
 * from the May 2026 audit.
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

/**
 * Render the args row that follows the tool name in the inline label.
 * Returns just the args string; the caller prefixes with the tool name.
 */
export function summarizeToolArgs(name: string, args: unknown): string {
	const o = asObj(args) ?? {};
	switch (name) {
		case "read": {
			const path = str(o.path) ?? str(o.filePath) ?? "";
			return trunc(path);
		}
		case "write": {
			const path = str(o.path) ?? str(o.filePath) ?? "";
			return trunc(path);
		}
		case "edit": {
			const path = str(o.path) ?? str(o.filePath) ?? "";
			const edits = arr(o.edits);
			const count = edits?.length ?? 1;
			return trunc(`${path} (${count} edit${count === 1 ? "" : "s"})`);
		}
		case "update_sidebar": {
			const op = str(o.operation) ?? "";
			const id = str(o.id) ?? "";
			return trunc(`${op} "${id}"`);
		}
		default: {
			// Unknown tool — fall back to a compact JSON preview.
			try {
				return trunc(JSON.stringify(args) ?? "", 60);
			} catch {
				return "";
			}
		}
	}
}
