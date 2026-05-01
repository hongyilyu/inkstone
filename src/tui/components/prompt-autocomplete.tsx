import type { TextareaRenderable } from "@opentui/core";
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
import { listVaultFiles } from "../util/vault-files";
import { useCommand } from "./dialog-command";

/**
 * Autocomplete dropdown for the prompt textarea.
 *
 * Two modes, mutually exclusive (single `mode` state machine, matching
 * OpenCode's `store.visible: false | "@" | "/"`):
 *
 *   - `"slash"` — triggered by `/` at column 0, reads entries with a
 *     `slash` field from the unified command registry. Selection
 *     writes the textarea via `props.setText`, flowing back through
 *     the controlled `<input>`'s `value={text()}` → `set value`.
 *   - `"mention"` — triggered by `@` after whitespace or start-of-input,
 *     lists vault `.md`/`.markdown`/`.txt` files. Selection inserts a
 *     highlighted `@path` span into the textarea via imperative
 *     `input.deleteRange` + `input.insertText` + `input.extmarks.create`
 *     (direct buffer/extmark access — `value=` round-trips via
 *     `InputRenderable.setText` which clears all extmarks, so mention
 *     insertion can't go through `setText`).
 *
 * Dismissal (both modes): Esc, whitespace typed in the query, backspace
 * past the trigger, or explicit selection.
 *
 * Ported from OpenCode's `prompt/autocomplete.tsx` (slash + mention
 * subset only — no frecency, no directory expansion, no mouse
 * handling, no `@agent` mentions, no line-range syntax).
 */

type Mode = "slash" | "mention" | null;

/** Cap on visible rows in the dropdown (matches OpenCode's limit). */
const MAX_RESULTS = 10;

interface Option {
	display: string;
	description?: string;
	onSelect: () => void;
}

export function PromptAutocomplete(props: {
	/** Current textarea value (reactive, mirrors `input.plainText`). */
	text: string;
	/** Replace the textarea value (drives the controlled `<input>`). */
	setText: (v: string) => void;
	/** Getter for the input renderable — used for mention-mode imperative edits. */
	input: () => TextareaRenderable | undefined;
	/** Prompt extmark type id (registered once in `prompt.tsx`). */
	promptPartTypeId: () => number;
	/** Style id for `extmark.file` (re-resolved on theme switch). */
	fileStyleId: () => number | null;
}) {
	const { theme } = useTheme();
	const command = useCommand();
	const dialog = useDialog();

	const [store, setStore] = createStore({
		mode: null as Mode,
		selected: 0,
		/**
		 * Byte offset of the trigger character (`/` or `@`) at the time
		 * the dropdown opened. Used to:
		 *   - compute the query = `text.slice(triggerIndex + 1, cursor)`
		 *   - locate where mention insertion should delete/replace
		 * Slash mode always has triggerIndex === 0 (column-0 only).
		 */
		triggerIndex: 0,
	});

	// Safety: if the component unmounts while the dropdown is visible,
	// resume global keybind dispatch so Ctrl+N/Ctrl+P aren't stuck.
	onCleanup(() => {
		if (store.mode !== null) command.resume();
	});

	// ------------------------------------------------------------
	// Slash mode — option list from the command registry.
	// ------------------------------------------------------------

	const slashOptions = createMemo((): Option[] => {
		const entries = command.visible();
		const raw: { name: string; description: string; onSelect: () => void }[] =
			[];
		for (const e of entries) {
			if (!e.slash) continue;
			raw.push({
				name: `/${e.slash.name}`,
				description: e.description ?? e.title,
				onSelect: () => {
					const input = props.input();
					if (e.slash?.takesArgs) {
						// Argful: insert `/name ` and let the user type the arg.
						// Textarea is uncontrolled (no `value=` prop), so write
						// goes through the renderable directly. `onContentChange`
						// will mirror `plainText` into the parent's `text()`
						// signal on the next tick.
						if (input) {
							input.setText(`/${e.slash.name} `);
							input.cursorOffset = input.plainText.length;
						}
						props.setText(`/${e.slash.name} `);
					} else {
						// Argless: clear buffer, fire the command.
						if (input) input.setText("");
						props.setText("");
						e.onSelect(dialog);
					}
				},
			});
		}
		raw.sort((a, b) => a.name.localeCompare(b.name));

		// Pad display strings so descriptions align (OpenCode pattern).
		const max = raw.reduce((m, o) => Math.max(m, o.name.length), 0);
		return raw.map((o) => ({
			display: max > 0 ? o.name.padEnd(max + 2) : o.name,
			description: o.description,
			onSelect: o.onSelect,
		}));
	});

	// ------------------------------------------------------------
	// Mention mode — option list from the vault file scanner.
	// First access triggers the lazy walk (session-scoped cache);
	// subsequent triggers are O(files).
	// ------------------------------------------------------------

	const mentionOptions = createMemo((): Option[] => {
		if (store.mode !== "mention") return [];
		const files = listVaultFiles();
		return files.map((path) => ({
			display: path,
			// No description — the path itself is the identifier.
			onSelect: () => insertMention(path),
		}));
	});

	function insertMention(path: string) {
		const input = props.input();
		if (!input) return;
		const styleId = props.fileStyleId();
		if (styleId === null) return; // Theme not ready; defensive.

		const triggerIndex = store.triggerIndex;
		const currentOffset = input.cursorOffset;

		// Delete the in-progress `@query` (from trigger up to cursor)
		// using logical cursor positions — `deleteRange` wants
		// row/col, and going via `cursorOffset` = offset on an
		// unwrapped single-line-ish buffer is the shape OpenCode uses
		// (autocomplete.tsx:162-167).
		input.cursorOffset = triggerIndex;
		const startCursor = input.logicalCursor;
		input.cursorOffset = currentOffset;
		const endCursor = input.logicalCursor;
		input.deleteRange(
			startCursor.row,
			startCursor.col,
			endCursor.row,
			endCursor.col,
		);

		// Insert `@path ` and create a virtual extmark over the `@path`
		// slice (trailing space stays ordinary text so the cursor can
		// exit the span naturally).
		const virtualText = `@${path}`;
		input.insertText(`${virtualText} `);

		input.extmarks.create({
			start: triggerIndex,
			end: triggerIndex + virtualText.length,
			virtual: true,
			styleId,
			typeId: props.promptPartTypeId(),
			metadata: { path },
		});
	}

	// ------------------------------------------------------------
	// Active options + filter text, based on mode.
	// ------------------------------------------------------------

	const filterText = createMemo(() => {
		if (store.mode === null) return "";
		const t = props.text;
		const start = store.triggerIndex + 1; // skip the trigger char
		if (start > t.length) return "";
		return t.slice(start);
	});

	const filtered = createMemo((): Option[] => {
		if (store.mode === null) return [];
		const all = store.mode === "slash" ? slashOptions() : mentionOptions();
		const needle = filterText();
		if (!needle) return all.slice(0, MAX_RESULTS);
		return fuzzysort
			.go(needle, all, {
				keys: [(o) => o.display.trimEnd(), (o) => o.description ?? ""],
				limit: MAX_RESULTS,
			})
			.map((r) => r.obj);
	});

	// Reset selection when filter changes.
	createEffect(() => {
		filterText();
		setStore("selected", 0);
	});

	// ------------------------------------------------------------
	// Visibility state machine.
	//
	// Slash takes precedence — when slash mode is active, any `@`
	// typed becomes part of the slash query, not a mention trigger.
	// This matches success criterion #7 in the plan.
	//
	// Reads `store.mode` inside `untrack` to avoid a self-dependency.
	// ------------------------------------------------------------

	createEffect(() => {
		const t = props.text;
		const mode = untrack(() => store.mode);

		if (mode === null) {
			// Nothing open — check for either trigger.
			// Slash: `/` at column 0, no whitespace yet.
			if (t.startsWith("/") && !/\s/.test(t)) {
				open("slash", 0);
				return;
			}
			// Mention: most recent `@` with no whitespace between it and
			// cursor, where the preceding char is whitespace or undefined.
			// `props.text` doesn't carry cursor state, so we scan the
			// whole string — good enough for the common append-only typing
			// path. Edge case (user moves cursor mid-string then types `@`)
			// isn't handled for MVP; OpenCode's version uses input cursor
			// directly via `input.cursorOffset`, but the simpler scan
			// covers the 99% case.
			const input = props.input();
			const cursor = input ? input.cursorOffset : t.length;
			const before = t.slice(0, cursor);
			const idx = before.lastIndexOf("@");
			if (idx === -1) return;
			const between = before.slice(idx);
			if (/\s/.test(between)) return;
			const preceding = idx === 0 ? undefined : before[idx - 1];
			if (preceding === undefined || /\s/.test(preceding)) {
				open("mention", idx);
			}
			return;
		}

		if (mode === "slash") {
			// Close on whitespace appearing, text no longer starting with
			// `/`, or empty.
			if (!t.startsWith("/") || /\s/.test(t) || t.length === 0) {
				close();
			}
			return;
		}

		if (mode === "mention") {
			// Close when: query contains whitespace, `@` no longer present
			// at trigger index, or text shorter than trigger.
			if (t.length <= store.triggerIndex) {
				close();
				return;
			}
			if (t[store.triggerIndex] !== "@") {
				close();
				return;
			}
			const query = t.slice(store.triggerIndex + 1);
			// Only look at chars between trigger and cursor for whitespace;
			// text after cursor is not part of the active mention.
			const input = props.input();
			const cursor = input ? input.cursorOffset : t.length;
			const activeQuery = t.slice(store.triggerIndex + 1, cursor);
			if (/\s/.test(activeQuery)) {
				close();
				return;
			}
			// If the whole trailing query has whitespace (user backed
			// cursor over it), also close — safety net.
			if (/\s/.test(query) && cursor >= t.length) {
				close();
			}
		}
	});

	function open(mode: Exclude<Mode, null>, triggerIndex: number) {
		setStore({ mode, triggerIndex, selected: 0 });
		command.suspend();
	}

	function close() {
		if (store.mode !== null) {
			setStore({ mode: null, selected: 0 });
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

	// ------------------------------------------------------------
	// Keyboard handler. Runs before the input's built-in Enter→submit
	// because `useKeyboard` fires globally before the focused input
	// processes the key. `preventDefault` stops the input from seeing
	// the consumed key.
	// ------------------------------------------------------------

	useKeyboard((evt: any) => {
		if (store.mode === null) return;
		if (dialog.stack.length > 0) return;

		const name = evt.name?.toLowerCase();
		const ctrlOnly = evt.ctrl && !evt.meta && !evt.shift;

		if (name === "up" || (ctrlOnly && name === "p")) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(-1);
			return;
		}
		if (name === "down" || (ctrlOnly && name === "n")) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(1);
			return;
		}
		if (name === "escape") {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			close();
			return;
		}
		if (name === "return" || name === "tab") {
			const opt = filtered()[store.selected];
			if (opt) {
				evt.preventDefault?.();
				evt.stopPropagation?.();
				close();
				opt.onSelect();
			}
			// No match: let Enter fall through to handleSubmit.
			return;
		}
	});

	const height = createMemo(() => Math.min(MAX_RESULTS, filtered().length));

	return (
		<box
			visible={store.mode !== null && filtered().length > 0}
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
