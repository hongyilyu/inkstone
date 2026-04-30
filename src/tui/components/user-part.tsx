/**
 * Single part inside a user bubble. Dispatches on `DisplayPart.type`:
 *
 * - `text`     → plain prose line.
 * - `file`     → MIME-badge chip (agent-colored bg + muted filename).
 * - `thinking` → unreachable today (reducer only pushes thinking onto
 *                assistant messages); returns null defensively.
 *
 * Mirrors the `TextPart` / `ReasoningPart` split on the assistant side
 * so each part type has a dedicated component and the parent `UserMessage`
 * stays a thin layout wrapper.
 */

import type { DisplayPart } from "@bridge/view-model";
import type { RGBA } from "@opentui/core";
import { useTheme } from "../context/theme";

/**
 * MIME → short badge label. Minimal on purpose: today only reader's
 * `/article` produces file parts, and those are always markdown. An
 * unknown mime falls back to the raw string so adding a future entry
 * is a one-line change.
 */
const MIME_BADGE: Record<string, string> = {
	"text/markdown": "md",
};

function mimeBadge(mime: string): string {
	return MIME_BADGE[mime] ?? mime;
}

export function UserPart(props: {
	part: DisplayPart;
	first: boolean;
	agentColor: RGBA;
}) {
	const { theme } = useTheme();

	if (props.part.type === "text") {
		return (
			<text fg={theme.text} marginTop={props.first ? 0 : 1}>
				{props.part.text}
			</text>
		);
	}
	if (props.part.type === "file") {
		return (
			<text wrapMode="none" marginTop={props.first ? 0 : 1}>
				<span
					style={{
						bg: props.agentColor,
						fg: theme.background,
					}}
				>
					{` ${mimeBadge(props.part.mime)} `}
				</span>
				<span
					style={{
						bg: theme.backgroundElement,
						fg: theme.textMuted,
					}}
				>
					{` ${props.part.filename} `}
				</span>
			</text>
		);
	}
	return null;
}
