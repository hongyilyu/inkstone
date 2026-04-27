import { VAULT_DIR } from "@backend/agent/constants";
import { TextAttributes } from "@opentui/core";
import { createMemo, Show } from "solid-js";
import pkg from "../../../package.json";
import { refocusInput } from "../app";
import { useAgent } from "../context/agent";
import { useTheme } from "../context/theme";
import { displayPath, formatCost, formatTokensFull } from "../util/format";

const SIDEBAR_WIDTH = 30;
// Inner content width = SIDEBAR_WIDTH - paddingLeft(2) - paddingRight(2)
const TITLE_MAX_CHARS = SIDEBAR_WIDTH - 4;

/**
 * Right-side session metadata panel.
 *
 * Layout:
 *   [title]        bold (first user msg, else "inkstone")
 *   Context        bold label
 *   tokens / % used / cost
 *   <spacer>
 *   vault path     muted
 *   version        muted
 */
export function Sidebar() {
	const { theme } = useTheme();
	const { store } = useAgent();

	// Display vault path with ~ for home dir (platform-neutral helper,
	// shared with the open-page footer).
	const vaultDisplay = displayPath(VAULT_DIR);

	const title = createMemo(() => {
		const firstUser = store.messages.find((m) => m.role === "user");
		const firstUserText = firstUser?.parts[0]?.text;
		if (firstUserText) {
			// Strip newlines so a multiline prompt doesn't blow up the title
			const flat = firstUserText.replace(/\s+/g, " ").trim();
			return flat.slice(0, TITLE_MAX_CHARS);
		}
		return "inkstone";
	});

	const contextPct = createMemo(() => {
		if (store.contextWindow <= 0) return null;
		return Math.round((store.totalTokens / store.contextWindow) * 100);
	});

	// Hide usage stats when counters are zeroed (e.g. reopened session where
	// totalTokens / totalCost were not persisted).
	const hasUsageData = createMemo(
		() => store.totalTokens > 0 || store.totalCost > 0,
	);

	return (
		<box
			width={SIDEBAR_WIDTH}
			flexShrink={0}
			flexDirection="column"
			backgroundColor={theme.backgroundPanel}
			paddingLeft={2}
			paddingRight={2}
			paddingTop={1}
			paddingBottom={1}
			gap={1}
			onMouseUp={() => setTimeout(() => refocusInput(), 1)}
		>
			{/* Title */}
			<text fg={theme.text} attributes={TextAttributes.BOLD}>
				{title()}
			</text>

			{/* Context */}
			<box flexDirection="column">
				<text fg={theme.text} attributes={TextAttributes.BOLD}>
					Context
				</text>
				<Show when={hasUsageData()}>
					<text fg={theme.textMuted}>
						{formatTokensFull(store.totalTokens)} tokens
					</text>
					<Show when={contextPct() !== null}>
						<text fg={theme.textMuted}>{contextPct()}% used</text>
					</Show>
					<text fg={theme.textMuted}>{formatCost(store.totalCost)} spent</text>
				</Show>
			</box>

			{/* Spacer pushes the bottom section down */}
			<box flexGrow={1} />

			{/* Bottom-anchored vault path + app/version */}
			<box flexDirection="column">
				<text fg={theme.textMuted} wrapMode="none">
					{vaultDisplay}
				</text>
				<box flexDirection="row" gap={1}>
					<text fg={theme.success}>•</text>
					<text fg={theme.textMuted}>InkStone {pkg.version}</text>
				</box>
			</box>
		</box>
	);
}
