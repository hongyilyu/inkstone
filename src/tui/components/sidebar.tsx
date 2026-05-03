import { VAULT_DIR } from "@backend/agent/constants";
import { TextAttributes } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import pkg from "../../../package.json";
import { refocusInput } from "../app";
import { useAgent } from "../context/agent";
import { closeSecondaryPage } from "../context/secondary-page";
import { useTheme } from "../context/theme";
import { displayPath, formatCost, formatTokensFull } from "../util/format";

const SIDEBAR_WIDTH = 30;
/**
 * Right-side session metadata panel.
 *
 * Layout:
 *   [back button]   only in secondary page view
 *   [title]         bold (first user msg, else "inkstone")
 *   Context         bold label
 *   tokens / % used / cost
 *   [dynamic sections]  from store.sidebarSections
 *   <spacer>
 *   vault path      muted
 *   version         muted
 */
export function Sidebar(props: { inSecondaryPage?: boolean }) {
	const { theme, syntax } = useTheme();
	const { store } = useAgent();

	// Display vault path with ~ for home dir (platform-neutral helper,
	// shared with the open-page footer).
	const vaultDisplay = displayPath(VAULT_DIR);

	const title = createMemo(() => {
		return store.sessionTitle.trim() || "inkstone";
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
			onMouseUp={() => setTimeout(() => refocusInput(), 1)}
		>
			{/* Top section — grows to fill, footer stays anchored below */}
			<box flexDirection="column" flexGrow={1} gap={1}>
				{/* Back button — only in secondary page view */}
				<Show when={props.inSecondaryPage}>
					<box onMouseDown={() => closeSecondaryPage()}>
						<text fg={theme.accent}>{"← Back"}</text>
					</box>
				</Show>

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
						<text fg={theme.textMuted}>
							{formatCost(store.totalCost)} spent
						</text>
					</Show>
				</box>

				{/* Dynamic sidebar sections from update_sidebar tool */}
				<For each={store.sidebarSections}>
					{(section) => (
						<box flexDirection="column">
							<text fg={theme.text} attributes={TextAttributes.BOLD}>
								{section.title}
							</text>
							<markdown
								content={section.content}
								syntaxStyle={syntax()}
								fg={theme.textMuted}
								bg={theme.backgroundPanel}
							/>
						</box>
					)}
				</For>
			</box>

			{/* Bottom-anchored vault path + app/version */}
			<box flexDirection="column" paddingTop={1}>
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
