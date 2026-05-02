/**
 * Write text to the terminal clipboard via OSC 52.
 *
 * Trimmed port of OpenCode's `util/clipboard.ts` copy path
 * (`../opencode/packages/opencode/src/cli/cmd/tui/util/clipboard.ts:25-32`).
 * OpenCode ships a full multi-platform clipboard (native subprocess +
 * `clipboardy` fallback); Inkstone only needs to copy short OAuth URLs,
 * so the OSC 52 slice is enough. When a second copy feature arrives
 * (copy-tool-output, copy-error-details) and hits a terminal that
 * doesn't honor OSC 52, port the rest.
 *
 * OSC 52 lets the *terminal emulator* write to the system clipboard,
 * which is the only path that works over SSH. Modern terminals
 * (Alacritty, WezTerm, iTerm2, kitty, Windows Terminal, Ghostty) all
 * honor it; older terminals silently drop the sequence — no error, but
 * nothing lands in the clipboard either. Acceptable given the narrow
 * use case (a fallback path: the user can still read the URL off the
 * screen).
 *
 * tmux/screen swallow OSC 52 by default; wrapping in a DCS passthrough
 * lets tmux forward the inner sequence to the outer terminal. OpenCode
 * uses the same pattern — we follow it byte-for-byte.
 */
export function copyToClipboardOSC52(text: string): void {
	if (!process.stdout.isTTY) return;
	const base64 = Buffer.from(text).toString("base64");
	const osc52 = `\x1b]52;c;${base64}\x07`;
	const passthrough = process.env.TMUX || process.env.STY;
	const sequence = passthrough ? `\x1bPtmux;\x1b${osc52}\x1b\\` : osc52;
	process.stdout.write(sequence);
}
