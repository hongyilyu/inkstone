import { useKeyboard } from "@opentui/solid";
import {
	type Accessor,
	createContext,
	createMemo,
	createSignal,
	getOwner,
	onCleanup,
	type ParentProps,
	runWithOwner,
	useContext,
} from "solid-js";
import { type DialogContext, useDialog } from "../ui/dialog";
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select";
import * as Keybind from "../util/keybind";

/**
 * Command registry + palette, ported from OpenCode's
 * `component/dialog-command.tsx` (trimmed — no slash commands, no suggested
 * category, no plugin owner dance since we have no plugin API yet).
 *
 * Pattern summary:
 *   - `CommandProvider` owns a signal of registration accessors. Each
 *     registration is a `() => CommandOption[]` wrapped in a `createMemo`,
 *     so any signals read inside track and re-run the registration.
 *   - A single `useKeyboard` inside the provider handles both the palette-
 *     open key (`command_list`) and global dispatch of any registered
 *     command that has a `keybind`.
 *   - Dispatch is suspended while a dialog is on the stack, matching
 *     OpenCode's scoping rule: dialog-local handlers take precedence.
 */

export interface CommandOption {
	/** Unique identifier; also serves as the DialogSelect value. */
	id: string;
	/** Title rendered in the palette. */
	title: string;
	/** Optional one-line description shown next to the title. */
	description?: string;
	/** Optional global keybind action name (from `Keybind.KEYBINDS`). */
	keybind?: Keybind.KeybindAction;
	/**
	 * Optional slash-command shape. When set, the entry surfaces in the
	 * `/`-triggered dropdown in the prompt textarea (`Autocomplete`). The
	 * dropdown reads visible entries directly — no separate getter on the
	 * context — and filters by `slash.name` + `description`. Invoking the
	 * entry from the dropdown calls the same `onSelect(dialog)` as the
	 * palette / keybind paths, so shell entries open the same dialogs
	 * regardless of invocation route.
	 *
	 * No `aliases` today — add when a concrete command needs one.
	 */
	slash?: { name: string };
	/**
	 * If true, the command does not appear in the palette. Useful for
	 * keybind-only actions like `agent_cycle` / `agent_cycle_reverse`
	 * that should fire the binding but not clutter the list.
	 */
	hidden?: boolean;
	onSelect: (dialog: DialogContext) => void;
}

type Registration = Accessor<CommandOption[]>;

function init() {
	// Capture the provider's owner so registrations made from async callers
	// (e.g. any future plugin surface) still get a reactive scope.
	const root = getOwner();
	const [registrations, setRegistrations] = createSignal<Registration[]>([]);
	const [suppressed, setSuppressed] = createSignal(false);
	const dialog = useDialog();

	const entries = createMemo(() => registrations().flatMap((x) => x()));
	const visible = createMemo(() => entries().filter((e) => !e.hidden));

	function showPalette() {
		dialog.replace(() => <DialogCommand visible={visible} />);
	}

	const api = {
		/** Reactive list of visible commands (for the palette). */
		visible,
		/** Open the command palette programmatically. */
		show: showPalette,
		/**
		 * Register a batch of commands. The callback is memoized and re-run
		 * whenever its tracked signals change, so gated commands (e.g. only
		 * valid on an empty session) can simply return `[]` when inactive.
		 *
		 * Returns a dispose function; also auto-disposes on the caller's
		 * `onCleanup`.
		 */
		register(cb: () => CommandOption[]): () => void {
			const owner = getOwner() ?? root;
			if (!owner) return () => {};

			let list: Registration | undefined;
			runWithOwner(owner, () => {
				list = createMemo(cb);
				const ref = list;
				setRegistrations((arr) => [ref, ...arr]);
				onCleanup(() => {
					setRegistrations((arr) => arr.filter((x) => x !== ref));
				});
			});

			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				const ref = list;
				if (!ref) return;
				setRegistrations((arr) => arr.filter((x) => x !== ref));
			};
		},
		/**
		 * Suspend global keybind dispatch (including the `command_list`
		 * palette-open key) while some other consumer owns the keyboard.
		 * Used today by `Autocomplete` so that when the `/` dropdown is
		 * visible, Ctrl+P does not open the palette and `session_interrupt`
		 * does not fire.
		 *
		 * Needed because multiple `useKeyboard` handlers all receive every
		 * event and fire in registration order; `CommandProvider` registers
		 * earlier than `Autocomplete` (which mounts inside `Prompt`), so an
		 * `evt.preventDefault()` from the Autocomplete handler would arrive
		 * too late. A signal read at the top of this handler short-circuits
		 * dispatch before that order matters.
		 */
		setSuppressed,
	};

	// Global dispatch: palette-open key first, then any registered command.
	// Skip entirely while a dialog is open so dialog-local handlers win,
	// and while another consumer has suspended dispatch via `setSuppressed`.
	useKeyboard((evt: any) => {
		if (dialog.stack.length > 0) return;
		if (suppressed()) return;
		if (evt.defaultPrevented) return;

		if (Keybind.match("command_list", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			showPalette();
			return;
		}

		for (const entry of entries()) {
			if (!entry.keybind) continue;
			if (Keybind.match(entry.keybind, evt)) {
				evt.preventDefault?.();
				evt.stopPropagation?.();
				entry.onSelect(dialog);
				return;
			}
		}
	});

	return api;
}

export type CommandContext = ReturnType<typeof init>;

const ctx = createContext<CommandContext>();

export function CommandProvider(props: ParentProps) {
	const value = init();
	return <ctx.Provider value={value}>{props.children}</ctx.Provider>;
}

export function useCommand() {
	const value = useContext(ctx);
	if (!value) {
		throw new Error("useCommand must be used within a CommandProvider");
	}
	return value;
}

/**
 * Internal palette component. Not exported — opened exclusively by
 * `CommandProvider` in response to the `command_list` keybind. Consumers that
 * want to open it programmatically use `useCommand().show()`.
 */
function DialogCommand(props: { visible: Accessor<CommandOption[]> }) {
	const dialog = useDialog();

	const options = createMemo<DialogSelectOption<string>[]>(() =>
		props.visible().map((entry) => ({
			title: entry.title,
			value: entry.id,
			description: formatDescription(entry),
		})),
	);

	return (
		<DialogSelect
			title="Command Panel"
			placeholder="Search commands..."
			options={options()}
			closeOnSelect={false}
			onSelect={(option) => {
				const entry = props.visible().find((e) => e.id === option.value);
				if (!entry) return;
				entry.onSelect(dialog);
			}}
		/>
	);
}

/**
 * Combine description and keybind hint for display in the palette:
 *   - both:          `"Switch agent (tab)"`
 *   - keybind only:  `"tab"`
 *   - description:   `"Switch agent"`
 *   - neither:       `undefined`
 */
function formatDescription(entry: CommandOption): string | undefined {
	const hint = entry.keybind ? Keybind.print(entry.keybind) : "";
	if (entry.description && hint) return `${entry.description} (${hint})`;
	if (entry.description) return entry.description;
	if (hint) return hint;
	return undefined;
}
