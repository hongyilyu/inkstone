/**
 * Fork-divider — inline seam announcing a routing transition.
 *
 * Per ADR 0015, a child session born from `forkSession()` carries a
 * `parts.type = "fork"` row in its display timeline. The renderer
 * paints a single muted line — no bubble frame, no agent footer,
 * distinct from `AssistantMessage` so the user reads it as a
 * structural seam, not as content.
 *
 * Layout: the user message renders ABOVE this divider (the parent
 * agent received it), then the divider says "→ Routing to <Target>",
 * then the child agent's reply streams below. The `targetAgent` comes
 * from the marker payload itself so the divider stays correct on
 * resume regardless of what `store.currentAgent` happens to be.
 */

import { getAgentInfo } from "@backend/agent";
import { useTheme } from "../context/theme";

export function ForkDivider(props: { targetAgent: string }) {
	const { theme } = useTheme();
	const targetDisplay = () => getAgentInfo(props.targetAgent).displayName;
	return (
		<box flexShrink={0} marginLeft={3}>
			<text fg={theme.textMuted}>→ Routing to {targetDisplay()}</text>
		</box>
	);
}
