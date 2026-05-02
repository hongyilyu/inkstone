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
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate
const CONTROL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Strip ANSI escape sequences and control bytes (C0 + C1 + DEL)
 * except TAB/LF/CR from `s`. Idempotent. O(n) in input length.
 */
export function stripAnsi(s: string): string {
	return s.replace(CSI, "").replace(CONTROL_BYTES, "");
}
