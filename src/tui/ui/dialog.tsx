import { type Renderable, RGBA } from "@opentui/core";
import {
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/solid";
import {
	batch,
	createContext,
	type JSX,
	type ParentProps,
	Show,
	useContext,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useTheme } from "../context/theme";
import * as Keybind from "../util/keybind";

/**
 * Dialog wrapper component.
 * Ported from OpenCode's ui/dialog.tsx
 */
export function Dialog(
	props: ParentProps<{
		size?: "medium" | "large" | "xlarge";
		onClose: () => void;
	}>,
) {
	const dimensions = useTerminalDimensions();
	const { theme } = useTheme();

	let dismiss = false;
	const width = () => {
		if (props.size === "xlarge") return 116;
		if (props.size === "large") return 88;
		return 60;
	};

	return (
		<box
			onMouseDown={() => {
				dismiss = false;
			}}
			onMouseUp={() => {
				if (dismiss) {
					dismiss = false;
					return;
				}
				props.onClose?.();
			}}
			width={dimensions().width}
			height={dimensions().height}
			alignItems="center"
			position="absolute"
			zIndex={3000}
			paddingTop={dimensions().height / 4}
			left={0}
			top={0}
			backgroundColor={RGBA.fromInts(
				Math.round(theme.background.r * 255),
				Math.round(theme.background.g * 255),
				Math.round(theme.background.b * 255),
				150,
			)}
		>
			<box
				onMouseUp={(e: any) => {
					dismiss = false;
					e.stopPropagation();
				}}
				width={width()}
				maxWidth={dimensions().width - 2}
				backgroundColor={theme.backgroundPanel}
				paddingTop={1}
			>
				{props.children}
			</box>
		</box>
	);
}

function init() {
	const [store, setStore] = createStore({
		stack: [] as {
			element: () => JSX.Element;
			onClose?: () => void;
		}[],
		size: "medium" as "medium" | "large" | "xlarge",
	});

	const renderer = useRenderer();

	/**
	 * Hook installed by `CommandProvider` so dialog push/pop can drive
	 * global keybind suppression. Set to `null` when unwired (e.g. a
	 * test harness mounts only `DialogProvider`) — in that case the
	 * suspension calls are silent no-ops. Invariant: in the shipped app,
	 * `CommandProvider` must be a descendant of `DialogProvider` and
	 * install this handler at mount.
	 *
	 * Transition-edge contract: `suspend()` fires when the stack goes
	 * from empty to non-empty; `resume()` fires when it goes from
	 * non-empty to empty. This keeps the suspend count balanced even
	 * if `replace()` is called on an already-occupied stack (still one
	 * modal owning the keyboard).
	 */
	let suspendHandler: { suspend(): void; resume(): void } | null = null;

	useKeyboard((evt: any) => {
		if (store.stack.length === 0) return;
		if (evt.defaultPrevented) return;
		if (Keybind.match("dialog_close", evt)) {
			if (renderer.getSelection()) {
				renderer.clearSelection();
			}
			// biome-ignore lint/style/noNonNullAssertion: guarded by store.stack.length === 0 check above
			const current = store.stack.at(-1)!;
			current.onClose?.();
			const next = store.stack.slice(0, -1);
			setStore("stack", next);
			if (next.length === 0) suspendHandler?.resume();
			evt.preventDefault();
			evt.stopPropagation();
			refocus();
		}
	});

	let focus: Renderable | null = null;
	// Focus-restore timer. Coalesced so a rapid `clear()` → `replace()`
	// sequence in the same tick can't schedule two timers fighting over
	// which renderable to focus — the newer call cancels the older. Stops
	// a stale timer from re-focusing the input behind the freshly-mounted
	// dialog (the symptom is the user typing into the prompt instead of
	// the new dialog's filter on fast open/close/open navigation).
	let refocusTimer: ReturnType<typeof setTimeout> | null = null;
	function refocus() {
		if (refocusTimer !== null) clearTimeout(refocusTimer);
		refocusTimer = setTimeout(() => {
			refocusTimer = null;
			if (!focus) return;
			if (focus.isDestroyed) return;
			function find(item: Renderable): boolean {
				for (const child of item.getChildren()) {
					if (child === focus) return true;
					if (find(child)) return true;
				}
				return false;
			}
			const found = find(renderer.root);
			if (!found) return;
			focus.focus();
		}, 1);
	}

	return {
		clear() {
			const wasOccupied = store.stack.length > 0;
			for (const item of store.stack) {
				if (item.onClose) item.onClose();
			}
			batch(() => {
				setStore("size", "medium");
				setStore("stack", []);
			});
			if (wasOccupied) suspendHandler?.resume();
			refocus();
		},
		replace(input: () => JSX.Element, onClose?: () => void) {
			const wasEmpty = store.stack.length === 0;
			if (wasEmpty) {
				focus = renderer.currentFocusedRenderable;
				focus?.blur();
			}
			for (const item of store.stack) {
				if (item.onClose) item.onClose();
			}
			setStore("size", "medium");
			setStore("stack", [
				{
					element: input,
					onClose,
				},
			]);
			if (wasEmpty) suspendHandler?.suspend();
		},
		get stack() {
			return store.stack;
		},
		get size() {
			return store.size;
		},
		setSize(size: "medium" | "large" | "xlarge") {
			setStore("size", size);
		},
		/**
		 * Install a handler to receive suspend/resume calls on dialog
		 * open/close transitions. Called once by `CommandProvider` at
		 * mount. See the `suspendHandler` field docblock above for the
		 * transition-edge contract.
		 */
		setSuspendHandler(handler: { suspend(): void; resume(): void } | null) {
			suspendHandler = handler;
		},
	};
}

export type DialogContext = ReturnType<typeof init>;

const ctx = createContext<DialogContext>();

export function DialogProvider(props: ParentProps) {
	const value = init();
	return (
		<ctx.Provider value={value}>
			{props.children}
			<box position="absolute" zIndex={3000}>
				<Show when={value.stack.length}>
					<Dialog onClose={() => value.clear()} size={value.size}>
						{value.stack.at(-1)?.element}
					</Dialog>
				</Show>
			</box>
		</ctx.Provider>
	);
}

export function useDialog() {
	const value = useContext(ctx);
	if (!value) throw new Error("useDialog must be used within a DialogProvider");
	return value;
}
