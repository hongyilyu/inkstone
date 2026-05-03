import type { RGBA } from "@opentui/core";

/**
 * Semantic color palette shared by every themed renderable in the TUI.
 *
 * Every field is an `RGBA` except `thinkingOpacity`, which is a 0–1 float
 * multiplier applied to syntax-style foregrounds when rendering reasoning
 * ("thinking") blocks. Mirrors OpenCode's `Theme.thinkingOpacity` (see
 * `opencode/.../context/theme.tsx`) — the reasoning body uses a
 * `subtleSyntax` variant of the normal syntax rules with foregrounds
 * rebuilt at this alpha, producing a uniformly faded rendering while
 * preserving per-scope hue. 0.6 matches OpenCode's default.
 */
export interface ThemeColors {
	primary: RGBA;
	secondary: RGBA;
	accent: RGBA;
	error: RGBA;
	warning: RGBA;
	success: RGBA;
	info: RGBA;
	text: RGBA;
	textMuted: RGBA;
	selectedListItemText: RGBA;
	background: RGBA;
	backgroundPanel: RGBA;
	backgroundElement: RGBA;
	backgroundMenu: RGBA;
	border: RGBA;
	borderActive: RGBA;
	borderSubtle: RGBA;
	thinkingOpacity: number;
}

export interface ThemeDef {
	id: string;
	name: string;
	colors: ThemeColors;
}
