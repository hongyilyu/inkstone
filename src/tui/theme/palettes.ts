import { RGBA } from "@opentui/core";
import type { ThemeColors, ThemeDef } from "./types";

/** Short-form hex parser to keep palette tables compact. */
function hex(color: string): RGBA {
	return RGBA.fromHex(color);
}

const DARK: ThemeColors = {
	primary: hex("#fab283"),
	secondary: hex("#5c9cf5"),
	accent: hex("#9d7cd8"),
	error: hex("#e06c75"),
	warning: hex("#f5a742"),
	success: hex("#7fd88f"),
	info: hex("#56b6c2"),
	text: hex("#eeeeee"),
	textMuted: hex("#808080"),
	selectedListItemText: hex("#0a0a0a"),
	background: hex("#0a0a0a"),
	backgroundPanel: hex("#141414"),
	backgroundElement: hex("#1e1e1e"),
	backgroundMenu: hex("#1e1e1e"),
	border: hex("#484848"),
	borderActive: hex("#606060"),
	borderSubtle: hex("#3c3c3c"),
	thinkingOpacity: 0.6,
};

const LIGHT: ThemeColors = {
	primary: hex("#d75f00"),
	secondary: hex("#0550ae"),
	accent: hex("#8250df"),
	error: hex("#cf222e"),
	warning: hex("#bf8700"),
	success: hex("#1a7f37"),
	info: hex("#0969da"),
	text: hex("#1f2328"),
	textMuted: hex("#656d76"),
	selectedListItemText: hex("#ffffff"),
	background: hex("#ffffff"),
	backgroundPanel: hex("#f6f8fa"),
	backgroundElement: hex("#eaeef2"),
	backgroundMenu: hex("#eaeef2"),
	border: hex("#d0d7de"),
	borderActive: hex("#0969da"),
	borderSubtle: hex("#d8dee4"),
	thinkingOpacity: 0.6,
};

const CATPPUCCIN_MOCHA: ThemeColors = {
	primary: hex("#89b4fa"),
	secondary: hex("#cba6f7"),
	accent: hex("#f5c2e7"),
	error: hex("#f38ba8"),
	warning: hex("#f9e2af"),
	success: hex("#a6e3a1"),
	info: hex("#94e2d5"),
	text: hex("#cdd6f4"),
	textMuted: hex("#9399b2"),
	selectedListItemText: hex("#1e1e2e"),
	background: hex("#1e1e2e"),
	backgroundPanel: hex("#181825"),
	backgroundElement: hex("#11111b"),
	backgroundMenu: hex("#11111b"),
	border: hex("#313244"),
	borderActive: hex("#45475a"),
	borderSubtle: hex("#585b70"),
	thinkingOpacity: 0.6,
};

const DRACULA: ThemeColors = {
	primary: hex("#bd93f9"),
	secondary: hex("#ff79c6"),
	accent: hex("#8be9fd"),
	error: hex("#ff5555"),
	warning: hex("#f1fa8c"),
	success: hex("#50fa7b"),
	info: hex("#ffb86c"),
	text: hex("#f8f8f2"),
	textMuted: hex("#6272a4"),
	selectedListItemText: hex("#282a36"),
	background: hex("#282a36"),
	backgroundPanel: hex("#21222c"),
	backgroundElement: hex("#44475a"),
	backgroundMenu: hex("#44475a"),
	border: hex("#44475a"),
	borderActive: hex("#bd93f9"),
	borderSubtle: hex("#191a21"),
	thinkingOpacity: 0.6,
};

export const themes: ThemeDef[] = [
	{ id: "dark", name: "Dark", colors: DARK },
	{ id: "light", name: "Light", colors: LIGHT },
	{
		id: "catppuccin-mocha",
		name: "Catppuccin Mocha",
		colors: CATPPUCCIN_MOCHA,
	},
	{ id: "dracula", name: "Dracula", colors: DRACULA },
];

/**
 * Resolve a theme by id, falling back to the first theme when the id
 * is unknown. Used on boot (loading `config.json`) and during runtime
 * theme switches.
 */
export function getThemeById(id: string): ThemeDef {
	const found = themes.find((t) => t.id === id);
	if (found) return found;
	return themes[0] as ThemeDef;
}
