/**
 * Keybind registry + match/print helpers. See `docs/ARCHITECTURE.md`
 * § Keybinds + Commands for the overall pattern and scoping rules.
 *
 * Consumers: `Keybind.match("action", evt)` for dispatch, `Keybind.print("action")`
 * for hint labels. Action names are the single source of truth.
 */
import type { ParsedKey } from "@opentui/core";
import { isDeepEqual } from "remeda";

/**
 * Single parsed key combo. Mirrors OpenCode's `Info` shape minus `leader`.
 * `super` is kept for compatibility with OpenTUI's `ParsedKey` (where it's
 * optional) — `fromParsedKey` normalizes `undefined` to `false` so deep-equal
 * works without false negatives.
 */
export interface Info {
	name: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	super: boolean;
}

/**
 * Central keybind map. Each value is a comma-separated list of alternate
 * bindings; each alternate is a `+`-separated list of modifiers + a key
 * name. Tokens: `ctrl`, `alt` / `meta` / `option`, `shift`, `super`, `esc`
 * (alias for `escape`). Value `"none"` disables the binding.
 *
 * Collisions (all intentional, resolved by dispatch order / scope guards):
 *   - `ctrl+p` is both `command_list` and one alternate of `select_up`.
 *     CommandProvider guards its dispatch with `dialog.stack.length === 0`,
 *     and dialog-select calls `evt.preventDefault()` on nav matches.
 *   - `escape` is both `session_interrupt` and `dialog_close`. Dialog's
 *     useKeyboard runs first and calls `preventDefault` when a dialog is
 *     on the stack, so CommandProvider's dispatch sees an already-handled
 *     event (and also short-circuits on `dialog.stack.length > 0`).
 */
export const KEYBINDS = {
	app_exit: "ctrl+c",
	command_list: "ctrl+p",
	session_list: "ctrl+n",
	agent_cycle: "tab",
	agent_cycle_reverse: "shift+tab",
	messages_page_up: "pageup,meta+up",
	messages_page_down: "pagedown,meta+down",
	messages_first: "ctrl+home",
	messages_last: "ctrl+end",
	session_interrupt: "escape",
	dialog_close: "escape,ctrl+c",
	panel_close: "escape,ctrl+n",
	select_up: "up,ctrl+p",
	select_down: "down,ctrl+n",
	select_page_up: "pageup",
	select_page_down: "pagedown",
	select_first: "home",
	select_last: "end",
	select_submit: "return",
	article_close: "escape,ctrl+[",
} as const;

export type KeybindAction = keyof typeof KEYBINDS;

function parse(key: string): Info[] {
	if (key === "none") return [];
	return key.split(",").map((combo) => {
		const parts = combo.toLowerCase().split("+");
		const info: Info = {
			name: "",
			ctrl: false,
			meta: false,
			shift: false,
			super: false,
		};
		for (const part of parts) {
			switch (part) {
				case "ctrl":
					info.ctrl = true;
					break;
				case "alt":
				case "meta":
				case "option":
					info.meta = true;
					break;
				case "super":
					info.super = true;
					break;
				case "shift":
					info.shift = true;
					break;
				case "esc":
					info.name = "escape";
					break;
				default:
					info.name = part;
					break;
			}
		}
		return info;
	});
}

function fromParsedKey(key: ParsedKey): Info {
	return {
		// OpenTUI emits `" "` for space; normalize so bindings can spell it
		// as either "space" or " ".
		name: key.name === " " ? "space" : key.name,
		ctrl: key.ctrl,
		meta: key.meta,
		shift: key.shift,
		super: key.super ?? false,
	};
}

function matchInfo(a: Info, b: Info): boolean {
	return isDeepEqual(a, b);
}

function infoToString(info: Info | undefined): string {
	if (!info) return "";
	const parts: string[] = [];
	if (info.ctrl) parts.push("ctrl");
	if (info.meta) parts.push("alt");
	if (info.super) parts.push("super");
	if (info.shift) parts.push("shift");
	if (info.name) {
		parts.push(info.name === "delete" ? "del" : info.name);
	}
	return parts.join("+");
}

// Pre-parse once at module load so keypress dispatch is allocation-free in
// the hot path.
const PARSED: Record<KeybindAction, Info[]> = Object.fromEntries(
	(Object.entries(KEYBINDS) as [KeybindAction, string][]).map(([k, v]) => [
		k,
		parse(v),
	]),
) as Record<KeybindAction, Info[]>;

/**
 * Return true iff `evt` matches any alternate binding of `action`.
 *
 * `evt` is typed as OpenTUI's `ParsedKey`; the `KeyEvent` instances passed
 * into `useKeyboard` callbacks implement this interface, so raw `evt` objects
 * work without casting.
 */
export function match(action: KeybindAction, evt: ParsedKey): boolean {
	const list = PARSED[action];
	if (list.length === 0) return false;
	const parsed = fromParsedKey(evt);
	for (const item of list) {
		if (matchInfo(item, parsed)) return true;
	}
	return false;
}

/**
 * Human-readable label for the first alternate binding of `action`.
 * Used to render keybind hints in prompts, palette footers, etc. — keeps
 * labels in sync with bindings so renaming a key updates every UI surface.
 */
export function print(action: KeybindAction): string {
	return infoToString(PARSED[action][0]);
}
