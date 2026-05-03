import { getAgentInfo } from "@backend/agent";
import type { SessionSummary } from "@backend/persistence/sessions";
import { TextAttributes } from "@opentui/core";
import { Show } from "solid-js";
import { useTheme } from "../context/theme";
import { formatRelativeTime } from "../util/format";

export interface SessionListItemProps {
	row: SessionSummary;
	/** True iff this row is the keyboard-nav selection in the panel. */
	active: boolean;
	/** True iff this row is the currently-loaded session (● indicator). */
	current: boolean;
	/** Max character budget for the title before truncation with `…`. */
	titleMaxChars: number;
	onMouseOver(): void;
	onMouseUp(): void;
}

/**
 * Single row in the Ctrl+N session panel. Two lines:
 *   Line 1: `● <title>` (● only when `current`).
 *   Line 2: `<agent> · <relativeTime>` — agent tinted by its theme color.
 *
 * Rendering-only; all navigation state lives in the parent `SessionList`.
 */
export function SessionListItem(props: SessionListItemProps) {
	const { theme } = useTheme();

	return (
		<box
			flexDirection="column"
			backgroundColor={props.active ? theme.primary : theme.backgroundPanel}
			paddingLeft={props.current ? 0 : 2}
			paddingRight={1}
			paddingTop={0}
			paddingBottom={0}
			marginBottom={1}
			onMouseUp={() => props.onMouseUp()}
			onMouseOver={() => props.onMouseOver()}
		>
			<box flexDirection="row" gap={1}>
				<Show when={props.current}>
					<text
						flexShrink={0}
						fg={props.active ? theme.selectedListItemText : theme.primary}
					>
						●
					</text>
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
					wrapMode="none"
					overflow="hidden"
				>
					{truncate(rowTitle(props.row), props.titleMaxChars)}
				</text>
			</box>
			<box flexDirection="row" overflow="hidden">
				<text
					flexShrink={0}
					fg={
						props.active
							? theme.selectedListItemText
							: theme[getAgentInfo(props.row.agent).colorKey]
					}
					wrapMode="none"
				>
					{getAgentInfo(props.row.agent).displayName}
				</text>
				<text
					flexShrink={0}
					fg={props.active ? theme.selectedListItemText : theme.textMuted}
					wrapMode="none"
				>
					{" · "}
				</text>
				<text
					flexGrow={1}
					fg={props.active ? theme.selectedListItemText : theme.textMuted}
					wrapMode="none"
					overflow="hidden"
				>
					{formatRelativeTime(props.row.startedAt)}
				</text>
			</box>
		</box>
	);
}

function rowTitle(row: SessionSummary): string {
	return row.title.trim() || row.id;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
