/**
 * Single part inside a user bubble. Dispatches on `DisplayPart.type`:
 *
 * - `text`     → plain prose line.
 * - `file`     → MIME-badge chip (agent-colored bg + muted filename).
 *                Wrapped in a clickable `<box>` that opens the secondary
 *                reader page when clicked.
 * - `thinking` → unreachable today (reducer only pushes thinking onto
 *                assistant messages); returns null defensively.
 * - `tool`     → unreachable today (only assistant bubbles carry tool
 *                parts); returns null defensively.
 *
 * Mirrors the `TextPart` / `ReasoningPart` / `ToolPart` split on the
 * assistant side so each part type has a dedicated component and the
 * parent `UserMessage` stays a thin layout wrapper.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VAULT_DIR } from "@backend/agent/constants";
import { isInsideDir } from "@backend/agent/permissions";
import type { DisplayPart } from "@bridge/view-model";
import type { RGBA } from "@opentui/core";
import { openSecondaryPage } from "../context/secondary-page";
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
		const filename = props.part.filename;
		const handleClick = () => {
			try {
				const abs = resolve(VAULT_DIR, filename);
				if (!isInsideDir(abs, VAULT_DIR) || abs === VAULT_DIR) {
					openSecondaryPage({ content: `_Path outside vault: ${filename}_` });
					return;
				}
				const content = readFileSync(abs, "utf-8");
				openSecondaryPage({ content, title: filename });
			} catch {
				openSecondaryPage({ content: `_Could not read file: ${filename}_` });
			}
		};
		return (
			<box marginTop={props.first ? 0 : 1} onMouseDown={handleClick}>
				<text wrapMode="none">
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
			</box>
		);
	}
	return null;
}
