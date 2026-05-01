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
 *   - Dispatch is suppressed via `suspendCount > 0`. The autocomplete
 *     dropdown drives this directly; `DialogProvider` also drives it via
 *     `setSuspendHandler` so any open dialog suspends global keybinds
 *     without a second guard in this handler.
 */

/**
 * Declarative slash-command metadata attached to a `CommandOption`.
 *
 * The prompt's submit handler (`prompt.tsx:handleSubmit`) matches a typed
 * `/name args...` against entries whose `slash.name === name`, respecting
 * `takesArgs` gating. Palette / keybind dispatch still fire independently
 * via `onSelect`. `argHint` is reserved for a future dropdown UI (see
 * `docs/SLASH-COMMANDS.md`) that would prefill the textarea with
 * `/name ` on select — no UI consumes it today.
 */
export interface SlashSpec {
	name: string;
	takesArgs?: boolean;
	argHint?: string;
}

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
	 * Optional slash-command metadata. Typed `/name args...` in the prompt
	 * dispatches to this entry's `onSelect(dialog, args)`.
	 */
	slash?: SlashSpec;
	/**
	 * If true, the command does not appear in the palette. Useful for
	 * keybind-only actions like `agent_cycle` / `agent_cycle_reverse`
	 * that should fire the binding but not clutter the list. Also used
	 * for argful slash commands (`/article <filename>`) that make no
	 * sense without an argument — palette-click can't provide one, so
	 * they're slash-only.
	 */
	hidden?: boolean;
	/**
	 * Invoked by palette-select (with `args` unset), keybind dispatch
	 * (unset), or slash dispatch (set to the text after the verb, which
	 * may be empty when no args were typed).
	 */
	onSelect: (dialog: DialogContext, args?: string) => void;
}

type Registration = Accessor<CommandOption[]>;

function init() {
	// Capture the provider's owner so registrations made from async callers
	// (e.g. any future plugin surface) still get a reactive scope.
	const root = getOwner();
	const [registrations, setRegistrations] = createSignal<Registration[]>([]);
	const [suspendCount, setSuspendCount] = createSignal(0);
	const dialog = useDialog();

	const entries = createMemo(() => registrations().flatMap((x) => x()));
	const visible = createMemo(() => entries().filter((e) => !e.hidden));

	function showPalette() {
		dialog.replace(() => <DialogCommand visible={visible} />);
	}

	/**
	 * First slash match for `name`. First-match precedence means agent-
	 * scoped registrations (registered earlier in the registration list
	 * via `AgentProvider` mounting inside `CommandProvider`) beat shell-
	 * scoped ones on name collision — preserves the "agent overrides
	 * built-in" rule from AGENT-DESIGN.md D9.
	 */
	function findSlash(name: string): CommandOption | undefined {
		return entries().find((e) => e.slash?.name === name);
	}

	function canRunSlash(name: string, args: string): boolean {
		const entry = findSlash(name);
		if (!entry) return false;
		if (entry.slash?.takesArgs && args.trim().length === 0) return false;
		return true;
	}

	/**
	 * Dispatch `/name args` to the matching slash entry. Returns true if
	 * an entry was found and invoked; callers should check the return to
	 * decide whether to fall through (e.g. submit as a plain prompt).
	 */
	function triggerSlash(name: string, args: string): boolean {
		const entry = findSlash(name);
		if (!entry) return false;
		if (entry.slash?.takesArgs && args.trim().length === 0) return false;
		entry.onSelect(dialog, args);
		return true;
	}

	const api = {
		/** Reactive list of visible commands (for the palette). */
		visible,
		/** Open the command palette programmatically. */
		show: showPalette,
		/** See `canRunSlash` above. */
		canRunSlash,
		/** See `triggerSlash` above. */
		triggerSlash,
		/**
		 * Suspend / resume global keybind dispatch. Two callers:
		 *   - The autocomplete dropdown calls `suspend()` while visible
		 *     so Ctrl+N / Ctrl+P don't fire `session_list` /
		 *     `command_list` behind it.
		 *   - `DialogProvider` (via `setSuspendHandler`, wired below)
		 *     calls these on dialog push/pop transitions so an open
		 *     dialog blocks global keybinds without a second guard here.
		 * Balanced: every `suspend()` must pair with a `resume()`.
		 */
		suspend() {
			setSuspendCount((c) => c + 1);
		},
		resume() {
			setSuspendCount((c) => Math.max(0, c - 1));
		},
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
	};

	// Global dispatch: palette-open key first, then any registered command.
	// Single gate: `suspendCount > 0`. The autocomplete dropdown drives it
	// directly; `DialogProvider` drives it via `setSuspendHandler` below so
	// any open dialog also suspends dispatch.
	useKeyboard((evt: any) => {
		if (suspendCount() > 0) return;
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

	// Wire dialog push/pop into the suspend counter so an open dialog
	// suppresses global keybinds without a second guard on the handler.
	// Invariant: `DialogProvider` is an ancestor of `CommandProvider`
	// (see the provider tree in `app.tsx`). Unwire on cleanup so
	// re-mounts don't install a stale handler.
	dialog.setSuspendHandler({ suspend: api.suspend, resume: api.resume });
	onCleanup(() => dialog.setSuspendHandler(null));

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
