/**
 * Fork-divider — inline seam between a child session and its parent.
 *
 * Per ADR 0015, a child session born from `forkSession()` carries a
 * `parts.type = "fork"` row as its first display message. The renderer
 * paints a single muted line above the seeded content — no bubble frame,
 * no agent footer, distinct from `AssistantMessage` so the user reads
 * it as a structural seam, not as content.
 *
 * The current `originator` is always the router (PR 5 is the only
 * caller of `forkSession()` in this work). When user-initiated fork
 * lands later, the marker payload picks up an `originator` field and
 * this component branches on it.
 */

import { useTheme } from "../context/theme";

export function ForkDivider() {
	const theme = useTheme();
	return (
		<box flexShrink={0} marginLeft={3}>
			<text fg={theme.textMuted}>↳ Routed from Router</text>
		</box>
	);
}
