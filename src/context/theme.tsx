import { createContext, useContext, type ParentProps } from "solid-js"
import { RGBA } from "@opentui/core"

/**
 * Theme color tokens.
 * Matches OpenCode's TuiThemeCurrent shape (partial port).
 *
 * TODO: Port full upstream theme support from opencode/src/cli/cmd/tui/context/theme.tsx:
 * - Light/system color mode detection and switching
 * - Theme registry with multiple built-in themes (aura, catppuccin, dracula, etc.)
 * - Custom theme loading from user config directory
 * - Syntax highlighting / diff colors
 * - selectedForeground() helper for contrast-aware text on colored backgrounds
 * - thinkingOpacity token
 * - Per-theme terminal color overrides (TerminalColors)
 */
export interface ThemeColors {
  primary: RGBA
  secondary: RGBA
  accent: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  selectedListItemText: RGBA
  background: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
}

function hex(color: string): RGBA {
  return RGBA.fromHex(color)
}

/** OpenCode "opencode" theme — dark mode */
const DARK_THEME: ThemeColors = {
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
}

interface ThemeContext {
  theme: ThemeColors
}

const ctx = createContext<ThemeContext>()

export function ThemeProvider(props: ParentProps) {
  const value: ThemeContext = { theme: DARK_THEME }
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useTheme() {
  const value = useContext(ctx)
  if (!value) throw new Error("useTheme must be used within a ThemeProvider")
  return value
}
