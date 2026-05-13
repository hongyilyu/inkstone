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
	type Setter,
	useContext,
} from "solid-js";
import { type DialogContext, useDialog } from "../../ui/dialog";
import * as Keybind from "../../util/keybind";
import { DialogCommand } from "./command-palette";

/**
 * Command registry + palette provider, ported from OpenCode's
 * `component/dialog-command.tsx` (trimmed — no plugin owner dance since
 * we have no plugin API yet).
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
 *
 * Palette rendering lives in `./command-palette.tsx` — this file is the
 * registry + provider shell.
 */

/**
 * Declarative slash-command metadata attached to a `CommandOption`.
 *
 * The prompt's submit handler (`prompt.tsx:handleSubmit`) matches a typed
 * `/name args...` against entries whose `slash.name === name`, respecting
 * `takesArgs` gating. Palette / keybind dispatch still fire independently
 * via `onSelect`.
 *
 * `takesArgs` and `argHint` answer different questions and must be set
 * independently:
 *   - `takesArgs` — "is a non-empty arg REQUIRED for dispatch?" Gate used
 *     by `canRunSlash` / `triggerSlash` to decide whether bare `/name`
 *     dispatches or falls through as a plain prompt.
 *   - `argHint`   — "does this command ACCEPT an arg (required or
 *     optional)?" Used by the palette title renderer (`/name <hint>`)
 *     and by the slash dropdown's selection UX in
 *     `prompt-autocomplete.tsx`: argHint set → selection inserts
 *     `/name ` into the textarea so the user can type; unset → selection
 *     fires immediately.
 *
 * An optional-arg command (e.g. reader's `/article [filename]`) sets
 * `argHint: "[filename]"` + `takesArgs: false` — bare invocation is
 * valid (opens a picker), but dropdown-select should still let the user
 * optionally type a filename.
 *
 * `argGuide` is a separate, post-select coaching string (shown by the
 * prompt's hint row when the buffer is exactly `/name `). It does NOT
 * fall back from `argHint`: `argHint` drives palette + dropdown UX,
 * `argGuide` drives the coaching hint. Set independently.
 */
export interface SlashSpec {
	name: string;
	/** Alternate verbs (without leading `/`). See `docs/SLASH-COMMANDS.md`. */
	aliases?: string[];
	takesArgs?: boolean;
	argHint?: string;
	argGuide?: string;
	/**
	 * Pre-dispatch predicate, consulted by `canRunSlashEntry` AFTER the
	 * shape rules. Returning `false` rejects dispatch so the caller falls
	 * through to the plain-prompt path. Used by optional-arg commands
	 * (`argHint` set, `takesArgs: false`) where the shape rules can't
	 * separate prose-after-verb from a real arg — e.g. reader's
	 * `/article`. Cheap, sync, side-effect-free.
	 */
	canExecute?: (args: string) => boolean;
}

/**
 * Palette command. Appears in the Ctrl+P palette AND the slash
 * dropdown when `slash` is set. Used for program-level verbs:
 * `/clear`, model picker, theme picker, `/agents`, etc.
 *
 * Agent-declared verbs (Reader's `/article`, KB's `/ingest`) use a
 * separate channel — see `AgentSlashOption` and `registerAgentSlash`.
 * Per ADR 0006 the palette is program-config-scoped, so agent verbs
 * never live in the palette source.
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
	 * Optional slash-command metadata. Typed `/name args...` in the prompt
	 * dispatches to this entry's `onSelect(dialog, args)`.
	 */
	slash?: SlashSpec;
	/**
	 * If true, the command does not appear in the palette. Useful for
	 * keybind-only actions like `agent_cycle` / `agent_cycle_reverse`
	 * that should fire the binding but not clutter the list.
	 */
	hidden?: boolean;
	/**
	 * Invoked by palette-select (with `args` unset), keybind dispatch
	 * (unset), or slash dispatch (set to the text after the verb, which
	 * may be empty when no args were typed).
	 */
	onSelect: (dialog: DialogContext, args?: string) => void;
}

/**
 * Agent-declared slash command. Dropdown-only — agent verbs never
 * surface in the Ctrl+P palette per ADR 0006.
 *
 * `slash` is required (the channel is for slash dispatch by definition).
 * No `keybind` (agent verbs aren't keybind-bound) and no `hidden`
 * (the bucket itself is dropdown-only, no palette to hide from).
 */
export interface AgentSlashOption {
	/** Unique identifier. */
	id: string;
	/** Display title in the dropdown (e.g. `/article [filename]`). */
	title: string;
	/** Optional one-line description shown next to the title. */
	description?: string;
	/** Required slash-command metadata — agent verbs are slash-only. */
	slash: SlashSpec;
	/** Invoked by slash dispatch with the text after the verb. */
	onSelect: (dialog: DialogContext, args?: string) => void;
}

/**
 * Single source of truth for slash dispatch gating. Three rules:
 *   1. `takesArgs: true`, args empty → reject (required arg missing).
 *   2. `!takesArgs`, `!argHint`, args non-empty → reject (extra-args
 *      guard so `/clear my cache` falls through as a plain prompt
 *      instead of silently dropping " my cache").
 *   3. `canExecute(args) === false` → reject (per-command predicate
 *      after the shape rules pass; lets optional-arg commands
 *      distinguish prose-after-verb from a real arg without changing
 *      the shape contract — see reader's `/article`).
 * `argHint`'s presence means the command accepts an optional arg, so
 * trailing text is legal and rule 2 doesn't fire.
 *
 * Exported for unit testing in `test/command-slash.test.ts` — pure
 * function over `CommandOption` + `args`, no closure over registry
 * state, so the gating rules can be pinned in isolation.
 */
export function canRunSlashEntry(
	entry: CommandOption | AgentSlashOption,
	args: string,
): boolean {
	const spec = entry.slash;
	if (spec?.takesArgs && args.trim().length === 0) return false;
	if (!spec?.takesArgs && !spec?.argHint && args.trim().length > 0)
		return false;
	if (spec?.canExecute && !spec.canExecute(args)) return false;
	return true;
}

/**
 * Resolve a typed slash name to its registry entry. Canonical `name`
 * matches win over `aliases` matches. See `docs/SLASH-COMMANDS.md`.
 */
export function findSlashEntry<T extends { slash?: SlashSpec }>(
	entries: readonly T[],
	name: string,
): T | undefined {
	return (
		entries.find((e) => e.slash?.name === name) ??
		entries.find((e) => e.slash?.aliases?.includes(name))
	);
}

type PaletteRegistration = Accessor<CommandOption[]>;
type AgentSlashRegistration = Accessor<AgentSlashOption[]>;

function init() {
	// Capture the provider's owner so registrations made from async callers
	// (e.g. any future plugin surface) still get a reactive scope.
	const root = getOwner();
	// Two channels (per ADR 0006):
	//   - `paletteRegs`     → palette commands. Visible in palette
	//                          AND dropdown when their `slash` is set.
	//   - `agentSlashRegs`  → agent verbs. Dropdown-only.
	// The two reactive lists are concatenated for slash dispatch with
	// agent verbs first so they win on name collision (AGENT-DESIGN.md
	// D9 "agent overrides built-in").
	const [paletteRegs, setPaletteRegs] = createSignal<PaletteRegistration[]>([]);
	const [agentSlashRegs, setAgentSlashRegs] = createSignal<
		AgentSlashRegistration[]
	>([]);
	const [suspendCount, setSuspendCount] = createSignal(0);
	const dialog = useDialog();

	const paletteEntries = createMemo(() => paletteRegs().flatMap((x) => x()));
	const agentSlashEntries = createMemo(() =>
		agentSlashRegs().flatMap((x) => x()),
	);
	const visible = createMemo(() => paletteEntries().filter((e) => !e.hidden));
	// Dropdown reads agent verbs first so a name collision resolves
	// to the agent entry (preserves D9). The palette source contributes
	// any palette command that has a `slash` field (e.g. `/clear`).
	const slashOptions = createMemo(() => [
		...agentSlashEntries(),
		...paletteEntries().filter((e) => e.slash),
	]);

	function showPalette() {
		dialog.replace(() => <DialogCommand visible={visible} />);
	}

	function findSlash(
		name: string,
	): CommandOption | AgentSlashOption | undefined {
		return findSlashEntry(slashOptions(), name);
	}

	function canRunSlash(name: string, args: string): boolean {
		const entry = findSlash(name);
		if (!entry) return false;
		return canRunSlashEntry(entry, args);
	}

	/**
	 * Dispatch `/name args` to the matching slash entry. Returns true if
	 * an entry was found and invoked; callers should check the return to
	 * decide whether to fall through (e.g. submit as a plain prompt).
	 */
	function triggerSlash(name: string, args: string): boolean {
		const entry = findSlash(name);
		if (!entry) return false;
		if (!canRunSlashEntry(entry, args)) return false;
		entry.onSelect(dialog, args);
		return true;
	}

	const api = {
		/** Reactive list of visible palette commands (for Ctrl+P). */
		visible,
		/** Reactive list of all slash-dispatchable entries (for the dropdown). */
		slashOptions,
		/** Open the command palette programmatically. */
		show: showPalette,
		/** See `canRunSlash` above. */
		canRunSlash,
		/** See `triggerSlash` above. */
		triggerSlash,
		/**
		 * Lookup a slash entry by name. Returns entries whether visible
		 * or hidden — the caller decides what to do with the result (e.g.
		 * the post-select hint row in `prompt.tsx` uses this to read
		 * `argGuide` regardless of palette-visibility).
		 */
		findSlash,
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
			return registerInto(cb, setPaletteRegs);
		},
		/**
		 * Register agent-declared slash verbs (dropdown-only). Same
		 * reactive memo semantics as `register` — the callback re-runs
		 * when its tracked signals change, so an agent bridge can
		 * return `[]` while inactive.
		 */
		registerAgentSlash(cb: () => AgentSlashOption[]): () => void {
			return registerInto(cb, setAgentSlashRegs);
		},
	};

	// Shared registration helper. Same memoize-and-prepend shape for
	// both channels — newest registrations (e.g. an agent bridge that
	// just mounted) sit at the head of the list, which preserves the
	// D9 "agent overrides built-in" precedence on slash-name collision.
	function registerInto<T>(
		cb: () => T[],
		setRegs: Setter<Accessor<T[]>[]>,
	): () => void {
		const owner = getOwner() ?? root;
		if (!owner) return () => {};

		let list: Accessor<T[]> | undefined;
		runWithOwner(owner, () => {
			list = createMemo(cb);
			const ref = list;
			setRegs((arr) => [ref, ...arr]);
			onCleanup(() => {
				setRegs((arr) => arr.filter((x) => x !== ref));
			});
		});

		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			const ref = list;
			if (!ref) return;
			setRegs((arr) => arr.filter((x) => x !== ref));
		};
	}

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

		// Keybinds live on palette commands only (agent verbs are
		// dropdown-only and don't carry `keybind`).
		for (const entry of paletteEntries()) {
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
