import { useKeyboard } from "@opentui/solid";
import fuzzysort from "fuzzysort";
import {
	createEffect,
	createMemo,
	For,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useTheme } from "../context/theme";
import { useDialog } from "../ui/dialog";
import { useCommand } from "./dialog-command";

/**
 * Slash-command autocomplete dropdown for the prompt.
 *
 * Reads entries with a `slash` field from the unified command registry
 * and renders a filterable list above the textarea. Trigger: `/` typed
 * at column 0. Dismiss: Esc, space, backspace past the `/`, or
 * explicit selection.
 *
 * Ported from OpenCode's `prompt/autocomplete.tsx` (slash-command
 * subset only — no `@` mentions, no frecency, no directory expansion,
 * no mouse handling). See `docs/SLASH-COMMANDS.md` for design history.
 */

interface SlashOption {
	display: string;
	description?: string;
	onSelect: () => void;
}

export function PromptAutocomplete(props: {
	/** Current textarea value (reactive). */
	text: string;
	/** Callback to replace the textarea value. */
	setText: (v: string) => void;
}) {
	const { theme } = useTheme();
	const command = useCommand();
	const dialog = useDialog();

	const [store, setStore] = createStore({
		visible: false,
		selected: 0,
	});

	// Safety: if the component unmounts while the dropdown is visible,
	// resume global keybind dispatch so Ctrl+N/Ctrl+P aren't stuck.
	onCleanup(() => {
		if (store.visible) command.resume();
	});

	// Build the slash option list from the command registry. Only entries
	// with a `slash` field participate. Sorted alphabetically, with the
	// display padded to align descriptions (matches OpenCode's padding).
	const slashOptions = createMemo((): SlashOption[] => {
		const entries = command.visible();
		const raw: { name: string; description: string; onSelect: () => void }[] =
			[];
		for (const e of entries) {
			if (!e.slash) continue;
			raw.push({
				name: `/${e.slash.name}`,
				description: e.description ?? e.title,
				onSelect: () => {
					if (e.slash?.takesArgs) {
						// Argful: insert `/name ` and let the user type the arg.
						props.setText(`/${e.slash.name} `);
					} else {
						// Argless: fire immediately.
						props.setText("");
						e.onSelect(dialog);
					}
				},
			});
		}
		raw.sort((a, b) => a.name.localeCompare(b.name));

		// Pad display strings so descriptions align (OpenCode pattern).
		// Build new objects so the memo returns immutable values.
		const max = raw.reduce((m, o) => Math.max(m, o.name.length), 0);
		return raw.map((o) => ({
			display: max > 0 ? o.name.padEnd(max + 2) : o.name,
			description: o.description,
			onSelect: o.onSelect,
		}));
	});

	// Filter text = everything after the leading `/`.
	const filterText = createMemo(() => {
		if (!store.visible) return "";
		const t = props.text;
		if (!t.startsWith("/")) return "";
		return t.slice(1);
	});

	// Filtered options via fuzzysort.
	const filtered = createMemo((): SlashOption[] => {
		if (!store.visible) return [];
		const needle = filterText();
		const all = slashOptions();
		if (!needle) return all;
		return fuzzysort
			.go(needle, all, {
				keys: [(o) => o.display.trimEnd(), (o) => o.description ?? ""],
			})
			.map((r) => r.obj);
	});

	// Reset selection when filter changes.
	createEffect(() => {
		filterText();
		setStore("selected", 0);
	});

	// Visibility state machine: show when text starts with `/` and has
	// no whitespace (column-0-only trigger, dismiss on space). Reads
	// `store.visible` inside `untrack` to break the self-dependency —
	// the effect should re-run only when `props.text` changes.
	// Suspend/resume global keybind dispatch so Ctrl+N/Ctrl+P don't
	// fire `session_list` / `command_list` while the dropdown is open.
	createEffect(() => {
		const t = props.text;
		const wasVisible = untrack(() => store.visible);
		if (!wasVisible) {
			// Open: `/` at position 0, no whitespace yet.
			if (t.startsWith("/") && !/\s/.test(t)) {
				setStore("visible", true);
				command.suspend();
			}
		} else {
			// Close: text no longer starts with `/`, or whitespace appeared,
			// or text is empty.
			if (!t.startsWith("/") || /\s/.test(t) || t.length === 0) {
				setStore("visible", false);
				command.resume();
			}
		}
	});

	function hide() {
		if (store.visible) {
			setStore("visible", false);
			command.resume();
		}
	}

	function move(dir: -1 | 1) {
		const len = filtered().length;
		if (len === 0) return;
		let next = store.selected + dir;
		if (next < 0) next = len - 1;
		if (next >= len) next = 0;
		setStore("selected", next);
	}

	// Keyboard handler. Runs before the input's built-in Enter→submit
	// because `useKeyboard` fires globally before the focused input
	// processes the key. `preventDefault` stops the input from seeing
	// the consumed key.
	useKeyboard((evt: any) => {
		if (!store.visible) return;
		if (dialog.stack.length > 0) return;

		const name = evt.name?.toLowerCase();
		const ctrlOnly = evt.ctrl && !evt.meta && !evt.shift;

		// Up / Ctrl+P
		if (name === "up" || (ctrlOnly && name === "p")) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(-1);
			return;
		}
		// Down / Ctrl+N
		if (name === "down" || (ctrlOnly && name === "n")) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(1);
			return;
		}
		// Escape — dismiss dropdown
		if (name === "escape") {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			hide();
			return;
		}
		// Enter / Tab — select if there's a match. `preventDefault` is
		// called only after confirming the option exists so a stale
		// `store.selected` doesn't swallow Enter without acting.
		if (name === "return" || name === "tab") {
			const opt = filtered()[store.selected];
			if (opt) {
				evt.preventDefault?.();
				evt.stopPropagation?.();
				hide();
				opt.onSelect();
			}
			// No match: let Enter fall through to handleSubmit (plain prompt).
			return;
		}
	});

	const height = createMemo(() => Math.min(10, filtered().length));

	return (
		<box
			visible={store.visible && filtered().length > 0}
			position="absolute"
			bottom={6}
			left={0}
			right={0}
			zIndex={100}
			border={["top", "bottom"]}
			borderColor={theme.border}
		>
			<box
				backgroundColor={theme.backgroundElement}
				height={height()}
				flexDirection="column"
			>
				<For each={filtered()}>
					{(option, index) => (
						<box
							paddingLeft={1}
							paddingRight={1}
							backgroundColor={
								index() === store.selected ? theme.primary : undefined
							}
							flexDirection="row"
						>
							<text
								fg={
									index() === store.selected
										? theme.selectedListItemText
										: theme.text
								}
								flexShrink={0}
							>
								{option.display}
							</text>
							<Show when={option.description}>
								<text
									fg={
										index() === store.selected
											? theme.selectedListItemText
											: theme.textMuted
									}
									wrapMode="none"
								>
									{option.description}
								</text>
							</Show>
						</box>
					)}
				</For>
			</box>
		</box>
	);
}
