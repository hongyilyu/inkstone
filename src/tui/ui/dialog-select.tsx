import {
	type InputRenderable,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import fuzzysort from "fuzzysort";
import { isDeepEqual } from "remeda";
import {
	batch,
	createEffect,
	createMemo,
	For,
	type JSX,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { useTheme } from "../context/theme";
import * as Keybind from "../util/keybind";
import { useDialog } from "./dialog";
import { countRows, groupByCategory } from "./dialog-select-grouping";
import { DialogSelectRow } from "./dialog-select-row";

export interface DialogSelectOption<T = any> {
	title: string;
	value: T;
	description?: string;
	category?: string;
	/**
	 * Optional node rendered in the fixed-width slot to the left of the
	 * title when this row is not the `current` one (the `current` indicator
	 * `●` takes precedence and is mutually exclusive). Callers use this
	 * for per-row status glyphs — e.g. DialogProvider renders a green `✓`
	 * in the gutter for connected providers.
	 */
	gutter?: JSX.Element;
}

export interface DialogSelectProps<T> {
	title: string;
	placeholder?: string;
	options: DialogSelectOption<T>[];
	onSelect?: (option: DialogSelectOption<T>) => void;
	current?: T;
	closeOnSelect?: boolean;
}

/**
 * Fuzzy-searchable select dialog.
 * Ported from OpenCode's ui/dialog-select.tsx (minimal slice).
 *
 * Row rendering lives in `./dialog-select-row.tsx`; grouping + height
 * math lives in `./dialog-select-grouping.ts`. This file owns the
 * state store, keyboard nav, scroll sync, and composition.
 *
 * TODO: Port remaining upstream features from opencode/src/cli/cmd/tui/ui/dialog-select.tsx:
 * - skipFilter option to disable filtering
 * - Per-option keybind actions (keybind[] prop with footer display)
 * - selectedForeground() for contrast-aware highlight text
 * - Scroll acceleration (getScrollAcceleration util)
 * - Disabled items (disabled flag + dimmed rendering)
 * - footer / margin / categoryView slots per option
 * - DialogSelectRef for external control (moveTo, getSelected)
 * - onMove / onFilter callbacks
 * - flat mode toggle
 */
export function DialogSelect<T>(props: DialogSelectProps<T>) {
	const dialog = useDialog();
	const { theme } = useTheme();

	const [store, setStore] = createStore({
		selected: 0,
		filter: "",
		input: "keyboard" as "keyboard" | "mouse",
	});

	// When current prop is set, scroll to it
	createEffect(
		on(
			() => props.current,
			(current) => {
				if (current) {
					const currentIndex = flat().findIndex((opt) =>
						isDeepEqual(opt.value, current),
					);
					if (currentIndex >= 0) {
						setStore("selected", currentIndex);
					}
				}
			},
		),
	);

	let input: InputRenderable;
	// Focus-after-mount timer. Coalesced: if `ref` fires twice in quick
	// succession (rare — only on rapid dialog open/close/open in one
	// tick), clear the prior pending timer so only the latest ref's
	// focus lands. Stops a stale timer from focusing a destroyed
	// renderable or fighting a second timer on the same instance.
	let focusTimer: ReturnType<typeof setTimeout> | null = null;

	const filtered = createMemo(() => {
		const needle = store.filter.toLowerCase();
		if (!needle) return props.options;
		return fuzzysort
			.go(needle, props.options, { key: "title" })
			.map((x) => x.obj);
	});

	// When the filter changes, the mousemove might still be triggered
	// via a synthetic event as layout moves underneath the cursor.
	// Force keyboard mode to prevent mouseover from hijacking selection.
	createEffect(() => {
		filtered();
		setStore("input", "keyboard");
	});

	const flat = createMemo(() => filtered());

	const grouped = createMemo(() => groupByCategory(flat()));

	const rows = createMemo(() => countRows(grouped()));

	const dimensions = useTerminalDimensions();
	const height = createMemo(() =>
		Math.min(rows(), Math.floor(dimensions().height / 2) - 6),
	);

	const selected = createMemo(() => flat()[store.selected]);

	// Reset selection when filter changes. The `setTimeout(0)` defers
	// the scroll sync until after Solid's batch flushes so `moveTo`
	// sees the freshly-rendered row ids. Coalesced: rapid filter
	// keystrokes would otherwise queue N timers — with a shared slot
	// only the most recent filter's move survives, which is what the
	// user actually wants.
	let moveTimer: ReturnType<typeof setTimeout> | null = null;
	createEffect(
		on([() => store.filter, () => props.current], ([filter, current]) => {
			if (moveTimer !== null) clearTimeout(moveTimer);
			moveTimer = setTimeout(() => {
				moveTimer = null;
				if (filter.length > 0) {
					moveTo(0, true);
				} else if (current) {
					const currentIndex = flat().findIndex((opt) =>
						isDeepEqual(opt.value, current),
					);
					if (currentIndex >= 0) {
						moveTo(currentIndex, true);
					}
				}
			}, 0);
		}),
	);
	onCleanup(() => {
		if (moveTimer !== null) clearTimeout(moveTimer);
		if (focusTimer !== null) clearTimeout(focusTimer);
	});

	function move(direction: number) {
		if (flat().length === 0) return;
		let next = store.selected + direction;
		if (next < 0) next = flat().length - 1;
		if (next >= flat().length) next = 0;
		moveTo(next, true);
	}

	function moveTo(next: number, center = false) {
		setStore("selected", next);
		if (!scroll) return;
		const target = scroll.getChildren().find((child) => {
			return child.id === JSON.stringify(selected()?.value);
		});
		if (!target) return;
		const y = target.y - scroll.y;
		if (center) {
			const centerOffset = Math.floor(scroll.height / 2);
			scroll.scrollBy(y - centerOffset);
		} else {
			if (y >= scroll.height) {
				scroll.scrollBy(y - scroll.height + 1);
			}
			if (y < 0) {
				scroll.scrollBy(y);
				if (isDeepEqual(flat()[0]?.value, selected()?.value)) {
					scroll.scrollTo(0);
				}
			}
		}
	}

	useKeyboard((evt: any) => {
		setStore("input", "keyboard");

		// Navigation bindings include emacs-style ctrl+p/ctrl+n on top of
		// arrow keys — see KEYBINDS.select_{up,down}. We `preventDefault` on
		// any nav match so the CommandProvider's ctrl+p palette-open binding
		// doesn't also fire (belt-and-suspenders alongside its
		// `dialog.stack.length > 0` guard).
		if (Keybind.match("select_up", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(-1);
			return;
		}
		if (Keybind.match("select_down", evt)) {
			evt.preventDefault?.();
			evt.stopPropagation?.();
			move(1);
			return;
		}
		if (Keybind.match("select_page_up", evt)) {
			evt.preventDefault?.();
			move(-10);
			return;
		}
		if (Keybind.match("select_page_down", evt)) {
			evt.preventDefault?.();
			move(10);
			return;
		}
		if (Keybind.match("select_first", evt)) {
			evt.preventDefault?.();
			moveTo(0);
			return;
		}
		if (Keybind.match("select_last", evt)) {
			evt.preventDefault?.();
			moveTo(flat().length - 1);
			return;
		}

		if (Keybind.match("select_submit", evt)) {
			const option = selected();
			if (option) {
				evt.preventDefault();
				evt.stopPropagation();
				props.onSelect?.(option);
				if (props.closeOnSelect !== false) {
					dialog.clear();
				}
			}
		}
	});

	let scroll: ScrollBoxRenderable | undefined;

	return (
		<box gap={1} paddingBottom={1}>
			<box paddingLeft={4} paddingRight={4}>
				<box flexDirection="row" justifyContent="space-between">
					<text fg={theme.text} attributes={TextAttributes.BOLD}>
						{props.title}
					</text>
					<text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
						esc
					</text>
				</box>
				<box paddingTop={1}>
					<input
						onInput={(e: string) => {
							batch(() => {
								setStore("filter", e);
							});
						}}
						backgroundColor={theme.backgroundPanel}
						focusedBackgroundColor={theme.backgroundPanel}
						textColor={theme.text}
						cursorColor={theme.primary}
						focusedTextColor={theme.text}
						ref={(r: InputRenderable) => {
							input = r;
							if (focusTimer !== null) clearTimeout(focusTimer);
							focusTimer = setTimeout(() => {
								focusTimer = null;
								if (!input) return;
								if (input.isDestroyed) return;
								input.focus();
							}, 1);
						}}
						placeholder={props.placeholder ?? "Search"}
						placeholderColor={theme.textMuted}
					/>
				</box>
			</box>
			<Show
				when={flat().length > 0}
				fallback={
					<box paddingLeft={4} paddingRight={4} paddingTop={1}>
						<text fg={theme.textMuted}>No results found</text>
					</box>
				}
			>
				<scrollbox
					paddingLeft={1}
					paddingRight={1}
					scrollbarOptions={{ visible: false }}
					ref={(r: ScrollBoxRenderable) => (scroll = r)}
					maxHeight={height()}
				>
					<For each={grouped()}>
						{([category, options], index) => (
							<>
								<Show when={category}>
									<box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3}>
										<text fg={theme.accent} attributes={TextAttributes.BOLD}>
											{category}
										</text>
									</box>
								</Show>
								<For each={options}>
									{(option) => {
										const active = createMemo(() =>
											isDeepEqual(option.value, selected()?.value),
										);
										const current = createMemo(() =>
											isDeepEqual(option.value, props.current),
										);
										return (
											<DialogSelectRow
												option={option}
												active={active()}
												current={current()}
												onMouseMove={() => {
													setStore("input", "mouse");
												}}
												onMouseUp={() => {
													props.onSelect?.(option);
													if (props.closeOnSelect !== false) {
														dialog.clear();
													}
												}}
												onMouseOver={() => {
													if (store.input !== "mouse") return;
													const idx = flat().findIndex((x) =>
														isDeepEqual(x.value, option.value),
													);
													if (idx === -1) return;
													moveTo(idx);
												}}
												onMouseDown={() => {
													const idx = flat().findIndex((x) =>
														isDeepEqual(x.value, option.value),
													);
													if (idx === -1) return;
													moveTo(idx);
												}}
											/>
										);
									}}
								</For>
							</>
						)}
					</For>
				</scrollbox>
			</Show>
		</box>
	);
}
