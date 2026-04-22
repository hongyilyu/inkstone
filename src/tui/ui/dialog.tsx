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
			element: JSX.Element;
			onClose?: () => void;
		}[],
		size: "medium" as "medium" | "large" | "xlarge",
	});

	const renderer = useRenderer();

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
			setStore("stack", store.stack.slice(0, -1));
			evt.preventDefault();
			evt.stopPropagation();
			refocus();
		}
	});

	let focus: Renderable | null = null;
	function refocus() {
		setTimeout(() => {
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
			for (const item of store.stack) {
				if (item.onClose) item.onClose();
			}
			batch(() => {
				setStore("size", "medium");
				setStore("stack", []);
			});
			refocus();
		},
		replace(input: any, onClose?: () => void) {
			if (store.stack.length === 0) {
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
