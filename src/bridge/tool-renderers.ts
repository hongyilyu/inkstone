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

/**
 * ANSI-escape + control-character sanitization for untrusted strings
 * rendered in the terminal grid.
 *
 * OpenTUI renders `<text>` nodes by writing bytes straight to the
 * terminal; escape sequences in those bytes are interpreted, which
 * lets tool arguments or provider error messages smear the TUI
 * (e.g. `\x1b[2J` to clear the screen, or a bare `\r` to overwrite
 * prior output). `<markdown>` passes through a tree-sitter parser
 * that neutralizes this at the rendering layer; the `<text>` path
 * doesn't.
 *
 * Sanitizer scope:
 * - CSI sequences: common shapes of `ESC [ P* I* F` (ECMA-48 CSI).
 *   The regex matches params (`[0-?]`) then intermediates (`[ -/]`)
 *   then final byte (`[@-~]`). Attacker-shaped CSI that violates the
 *   param-then-intermediate ordering isn't matched, but the leading
 *   ESC byte is still stripped by the C0 pass, so the residue
 *   surfaces as visible text rather than a terminal command.
 * - C0 control bytes (0x00-0x1F excluding TAB/LF/CR) and DEL (0x7F).
 * - C1 control bytes (0x80-0x9F). This covers 8-bit CSI (single
 *   byte `0x9B` in place of `ESC [`) and single-byte OSC (`0x9D`).
 *   Some terminals in 8-bit mode interpret these; scrubbing them
 *   is cheap defense.
 *
 * Not covered: 7-bit OSC (`ESC ] … BEL`) and DCS (`ESC P … ST`).
 * Rare in LLM-surfaced output; the leading ESC is still stripped by
 * the C0 pass, so the OSC/DCS residue doesn't execute. Revisit if a
 * real case appears.
 *
 * Preserved: TAB, LF, CR — those are layout-affecting but not
 * terminal-command sequences; Inkstone's renderers already handle
 * them as ordinary whitespace.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate
const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate
const CONTROL_BYTES_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Strip ANSI escape sequences and control bytes (C0 + C1 + DEL)
 * except TAB/LF/CR from `s`. Idempotent. O(n) in input length.
 */
function stripAnsi(s: string): string {
	return s.replace(CSI_RE, "").replace(CONTROL_BYTES_RE, "");
}

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
	dispatch(args) {
		const o = asObj(args) ?? {};
		const agent = str(o.agent) ?? "";
		return trunc(`→ ${agent}`);
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
