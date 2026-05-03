import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { useTheme } from "../context/theme";
import type { DialogSelectOption } from "./dialog-select";

/**
 * Truncate a string to a maximum length, replacing the tail with `…`.
 * Kept co-located with the row component that uses it; no other caller.
 */
function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 1)}…`;
}

/**
 * Single row inside a `DialogSelect` scrollbox. The parent computes
 * `active` / `current` via `createMemo` over its selection state and
 * `props.current`, so the row takes resolved booleans and stays a
 * presentational component.
 *
 * `active` = this row is highlighted (keyboard or mouse).
 * `current` = this row represents the caller's `props.current` value
 *             (mutually exclusive with a user-supplied `gutter`).
 *
 * The event callbacks bubble back to the parent so the input-mode
 * store, scroll sync, and dialog clear stay single-sourced in
 * `DialogSelect`.
 */
export interface DialogSelectRowProps<T> {
	option: DialogSelectOption<T>;
	active: boolean;
	current: boolean;
	onMouseMove: () => void;
	onMouseOver: () => void;
	onMouseDown: () => void;
	onMouseUp: () => void;
}

export function DialogSelectRow<T>(props: DialogSelectRowProps<T>) {
	const { theme } = useTheme();
	return (
		<box
			id={JSON.stringify(props.option.value)}
			flexDirection="row"
			position="relative"
			onMouseMove={props.onMouseMove}
			onMouseUp={props.onMouseUp}
			onMouseOver={props.onMouseOver}
			onMouseDown={props.onMouseDown}
			backgroundColor={props.active ? theme.primary : theme.backgroundPanel}
			paddingLeft={props.current || props.option.gutter ? 1 : 3}
			paddingRight={3}
			gap={1}
		>
			<Show when={props.current}>
				<text
					flexShrink={0}
					fg={props.active ? theme.selectedListItemText : theme.primary}
					marginRight={0}
				>
					●
				</text>
			</Show>
			<Show when={!props.current && props.option.gutter}>
				<box flexShrink={0} marginRight={0}>
					{props.option.gutter}
				</box>
			</Show>
			<text
				flexGrow={1}
				fg={
					props.active
						? theme.selectedListItemText
						: props.current
							? theme.primary
							: theme.text
				}
				attributes={props.active ? TextAttributes.BOLD : undefined}
				overflow="hidden"
				wrapMode="none"
			>
				{truncate(props.option.title, 61)}
			</text>
			<Show when={props.option.description}>
				<text
					flexShrink={0}
					fg={props.active ? theme.selectedListItemText : theme.textMuted}
					wrapMode="none"
				>
					{props.option.description}
				</text>
			</Show>
		</box>
	);
}
