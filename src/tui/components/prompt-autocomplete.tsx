import type { BoxRenderable, TextareaRenderable } from "@opentui/core";
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
import { useAnchorGeometry } from "../hooks/use-anchor-geometry";
import { type DialogContext, useDialog } from "../ui/dialog";
import { listVaultFiles } from "../util/vault-files";
import { deriveNextMode } from "./autocomplete/mode-state";
import { type CommandOption, useCommand } from "./dialog/command";

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
	/**
	 * Getter for the prompt wrapper box — the dropdown anchors its
	 * bottom edge to this box's top edge. Port of OpenCode's
	 * `anchor={() => anchor}` pattern (`prompt/index.tsx:956`,
	 * `prompt/autocomplete.tsx:112-126`). Without a live anchor the
	 * dropdown can't track textarea growth and ends up drifting into
	 * the prompt bubble when the textarea wraps past 1 row.
	 */
	anchor: () => BoxRenderable | undefined;
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

	const slashOptions = createMemo((): Option[] =>
		buildSlashOptions(command.visible(), {
			input: props.input,
			setText: props.setText,
			dialog,
		}),
	);

	// ------------------------------------------------------------
	// Mention mode — option list from the vault file scanner.
	// First access triggers the lazy walk (session-scoped cache);
	// subsequent triggers are O(files).
	// ------------------------------------------------------------

	const mentionOptions = createMemo((): Option[] => {
		if (store.mode !== "mention") return [];
		return buildMentionOptions(listVaultFiles(), (path) => insertMention(path));
	});

	function insertMention(path: string) {
		const input = props.input();
		if (!input) return;
		const styleId = props.fileStyleId();
		if (styleId === null) return; // Theme not ready; defensive.

		const triggerIndex = store.triggerIndex;
		const currentOffset = input.cursorOffset;

		// Delete the in-progress `@query` (from trigger up to cursor)
		// using logical cursor positions — `deleteRange` wants row/col,
		// going via `cursorOffset` = offset on an unwrapped single-line-
		// ish buffer is the shape OpenCode uses (autocomplete.tsx:162).
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
		// Bound by cursor, not end-of-buffer — otherwise inserting a
		// mention in the middle of an existing prompt folds the trailing
		// suffix into the search term and the filter stops matching.
		// Matches the `activeQuery` computation used by the mention-mode
		// close-gate below. Note: `input.cursorOffset` is non-reactive,
		// so this memo re-runs only when `props.text` changes — fine for
		// the common typing case; cursor-only arrow motion inside the
		// query lags by one keystroke (acceptable for MVP).
		const input = props.input();
		const end = input ? Math.min(input.cursorOffset, t.length) : t.length;
		if (end < start) return "";
		return t.slice(start, end);
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
	// Rule set (slash precedence, mention trigger gating, close
	// conditions) lives in the pure `deriveNextMode` function — see
	// `./autocomplete/mode-state.ts`. This effect just re-runs the
	// derivation on text changes and applies the resulting
	// transition.
	//
	// Reads `store.mode` and `store.triggerIndex` inside `untrack`
	// so the effect only re-fires when `props.text` changes (not on
	// every mode flip, which would cause a self-dependency loop).
	// ------------------------------------------------------------

	createEffect(() => {
		const t = props.text;
		const input = props.input();
		const cursor = input ? input.cursorOffset : t.length;
		const snapshot = untrack(() => ({
			currentMode: store.mode,
			currentTriggerIndex: store.triggerIndex,
		}));
		const transition = deriveNextMode({
			text: t,
			cursor,
			...snapshot,
		});
		if (transition.action === "open") {
			open(transition.mode, transition.triggerIndex);
		} else if (transition.action === "close") {
			close();
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

		// Nav keys only consume when there's a list to navigate. When
		// the user has typed past all matches the dropdown is hidden
		// (`visible={... && filtered().length > 0}`), but this handler
		// still fires globally — so without the guard, Up/Down would
		// silently swallow textarea navigation in the no-results state.
		const hasResults = filtered().length > 0;

		if (name === "up" || (ctrlOnly && name === "p")) {
			if (!hasResults) return;
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(-1);
			return;
		}
		if (name === "down" || (ctrlOnly && name === "n")) {
			if (!hasResults) return;
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

	const geometry = useAnchorGeometry({
		anchor: () => props.anchor(),
		visible: () => store.mode !== null && filtered().length > 0,
		itemCount: () => filtered().length,
		maxItems: MAX_RESULTS,
	});

	return (
		<box
			visible={store.mode !== null && filtered().length > 0}
			position="absolute"
			top={geometry().y}
			left={geometry().x}
			width={geometry().width}
			height={geometry().height}
			zIndex={100}
			backgroundColor={theme.backgroundElement}
			flexDirection="column"
		>
			<For each={filtered()}>
				{(option, index) => (
					<box
						// `paddingLeft={2}` matches the bubble's inner
						// `paddingLeft={2}` (prompt.tsx) so entry `/` chars
						// land at the same screen column as the textarea `/`.
						paddingLeft={2}
						paddingRight={2}
						backgroundColor={
							index() === store.selected
								? theme.primary
								: theme.backgroundElement
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
	);
}

// ---------------------------------------------------------------------------
// Option builders — pulled out of the component body so the mode-
// specific logic is readable without a 50-line `createMemo` per mode.
// ---------------------------------------------------------------------------

interface SlashSelectors {
	input: () => TextareaRenderable | undefined;
	setText: (v: string) => void;
	dialog: DialogContext;
}

/**
 * Build the slash-mode option list from the command registry's
 * visible entries. Each `onSelect` is a closure over the provided
 * selectors; the registry itself is pure data.
 *
 * Dropdown UX keys on `argHint` presence, not `takesArgs`.
 * `argHint` means "this command accepts an argument" (required OR
 * optional); `takesArgs` only answers the narrower "is an arg
 * required for dispatch" question used by `canRunSlash` /
 * `triggerSlash`. `/article` sets `argHint: "[filename]"` +
 * `takesArgs: false` (bare is valid, opens a picker); keying on
 * `takesArgs` here would fire the picker on dropdown-select
 * instead of letting the user optionally type a filename.
 */
function buildSlashOptions(
	entries: readonly CommandOption[],
	sel: SlashSelectors,
): Option[] {
	const raw: { name: string; description: string; onSelect: () => void }[] = [];
	for (const e of entries) {
		if (!e.slash) continue;
		raw.push({
			name: `/${e.slash.name}`,
			description: e.description ?? e.title,
			onSelect: () => {
				const input = sel.input();
				if (e.slash?.argHint) {
					// Argful: insert `/name ` and let the user type the arg.
					// Textarea is uncontrolled (no `value=` prop), so write
					// goes through the renderable directly. `onContentChange`
					// will mirror `plainText` into the parent's `text()`
					// signal on the next tick.
					if (input) {
						input.setText(`/${e.slash.name} `);
						input.cursorOffset = input.plainText.length;
					}
					sel.setText(`/${e.slash.name} `);
				} else {
					// Argless: clear buffer, fire the command.
					if (input) input.setText("");
					sel.setText("");
					e.onSelect(sel.dialog);
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
}

/**
 * Build the mention-mode option list from a vault path list. No
 * description — the path itself is the identifier.
 */
function buildMentionOptions(
	files: readonly string[],
	onSelect: (path: string) => void,
): Option[] {
	return files.map((path) => ({
		display: path,
		onSelect: () => onSelect(path),
	}));
}
