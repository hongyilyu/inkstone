import { batch, createContext, createEffect, createMemo, createSignal, on, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { RGBA, SyntaxStyle, type ThemeTokenStyle } from "@opentui/core"
import { loadConfig, saveConfig } from "../persistence/config"

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

export interface ThemeDef {
  id: string
  name: string
  colors: ThemeColors
}

function hex(color: string): RGBA {
  return RGBA.fromHex(color)
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
}

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
}

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
}

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
}

export const themes: ThemeDef[] = [
  { id: "dark", name: "Dark", colors: DARK },
  { id: "light", name: "Light", colors: LIGHT },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", colors: CATPPUCCIN_MOCHA },
  { id: "dracula", name: "Dracula", colors: DRACULA },
]

export function getThemeById(id: string): ThemeDef {
  const found = themes.find((t) => t.id === id)
  if (found) return found
  return themes[0] as ThemeDef
}

/**
 * Build the syntax-style rule set for the markdown renderer + fenced code blocks.
 * Reads only fields that already exist on ThemeColors — no new theme fields required.
 */
function getSyntaxRules(colors: ThemeColors): ThemeTokenStyle[] {
  return [
    { scope: ["default"], style: { foreground: colors.text } },

    // Markdown structure
    { scope: ["markup.heading"], style: { foreground: colors.primary, bold: true } },
    { scope: ["markup.heading.1"], style: { foreground: colors.primary, bold: true } },
    { scope: ["markup.heading.2"], style: { foreground: colors.primary, bold: true } },
    { scope: ["markup.heading.3"], style: { foreground: colors.primary, bold: true } },
    { scope: ["markup.heading.4"], style: { foreground: colors.primary, bold: true } },
    { scope: ["markup.heading.5"], style: { foreground: colors.primary, bold: true } },
    { scope: ["markup.heading.6"], style: { foreground: colors.primary, bold: true } },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: colors.text, bold: true } },
    { scope: ["markup.italic"], style: { foreground: colors.warning, italic: true } },
    { scope: ["markup.strikethrough"], style: { foreground: colors.textMuted } },
    { scope: ["markup.underline"], style: { foreground: colors.text, underline: true } },
    { scope: ["markup.list"], style: { foreground: colors.secondary } },
    { scope: ["markup.list.checked"], style: { foreground: colors.success } },
    { scope: ["markup.list.unchecked"], style: { foreground: colors.textMuted } },
    { scope: ["markup.quote"], style: { foreground: colors.warning, italic: true } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: colors.success } },
    { scope: ["markup.raw.inline"], style: { foreground: colors.success, background: colors.backgroundElement } },
    { scope: ["markup.link"], style: { foreground: colors.info, underline: true } },
    { scope: ["markup.link.label"], style: { foreground: colors.accent, underline: true } },
    { scope: ["markup.link.url"], style: { foreground: colors.info, underline: true } },
    { scope: ["conceal"], style: { foreground: colors.textMuted } },

    // Core code scopes (for fenced code blocks)
    { scope: ["comment"], style: { foreground: colors.textMuted, italic: true } },
    { scope: ["comment.documentation"], style: { foreground: colors.textMuted, italic: true } },
    { scope: ["keyword"], style: { foreground: colors.accent, italic: true } },
    { scope: ["keyword.return", "keyword.conditional", "keyword.repeat"], style: { foreground: colors.accent, italic: true } },
    { scope: ["keyword.function"], style: { foreground: colors.secondary } },
    { scope: ["keyword.import", "keyword.export"], style: { foreground: colors.accent } },
    { scope: ["keyword.type"], style: { foreground: colors.info, bold: true, italic: true } },
    { scope: ["keyword.modifier", "keyword.exception"], style: { foreground: colors.accent, italic: true } },
    { scope: ["string", "symbol", "character"], style: { foreground: colors.success } },
    { scope: ["string.escape", "string.regexp"], style: { foreground: colors.accent } },
    { scope: ["number", "boolean", "float", "constant"], style: { foreground: colors.warning } },
    { scope: ["type", "module", "class", "namespace"], style: { foreground: colors.info } },
    { scope: ["function", "function.call", "function.method", "function.method.call", "constructor"], style: { foreground: colors.secondary } },
    { scope: ["variable", "variable.parameter", "variable.member", "property", "parameter", "field"], style: { foreground: colors.text } },
    { scope: ["operator", "keyword.operator", "punctuation", "punctuation.bracket", "punctuation.delimiter"], style: { foreground: colors.text } },
    { scope: ["attribute", "annotation"], style: { foreground: colors.warning } },
    { scope: ["tag"], style: { foreground: colors.error } },
    { scope: ["tag.attribute"], style: { foreground: colors.accent } },
    { scope: ["variable.builtin", "type.builtin", "function.builtin", "constant.builtin"], style: { foreground: colors.error } },
  ]
}

function generateSyntax(colors: ThemeColors): SyntaxStyle {
  return SyntaxStyle.fromTheme(getSyntaxRules(colors))
}

interface ThemeContext {
  theme: ThemeColors
  themeId: () => string
  setTheme: (id: string) => void
  syntax: Accessor<SyntaxStyle>
}

const ctx = createContext<ThemeContext>()

export function ThemeProvider(props: ParentProps) {
  const savedId = loadConfig().themeId ?? "dark"
  const [themeId, setThemeId] = createSignal(savedId)
  const [theme, setThemeColors] = createStore<ThemeColors>({ ...getThemeById(savedId).colors })

  // Update store reactively when themeId signal changes
  createEffect(
    on(themeId, (id) => {
      const colors = getThemeById(id).colors
      batch(() => {
        for (const [key, value] of Object.entries(colors)) {
          setThemeColors(key as keyof ThemeColors, value as RGBA)
        }
      })
    }, { defer: true }),
  )

  // Regenerate SyntaxStyle whenever the active theme changes.
  // The memo depends on themeId — the store itself isn't tracked here
  // because each field is a separate reactive source; keying off themeId
  // avoids re-creating the style on every color write inside batch().
  //
  // SyntaxStyle wraps an FFI Pointer (see @opentui/core/zig.d.ts: destroySyntaxStyle).
  // JS GC cannot free the Zig-side allocations, so we explicitly .destroy() the
  // previous instance via onCleanup — fires on recompute (theme switch) and on
  // provider disposal (app exit).
  const syntax = createMemo(() => {
    const id = themeId()
    const style = generateSyntax(getThemeById(id).colors)
    onCleanup(() => style.destroy())
    return style
  })

  const value: ThemeContext = {
    theme,
    themeId,
    setTheme(id: string) {
      setThemeId(id)
      saveConfig({ themeId: id })
    },
    syntax,
  }
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useTheme() {
  const value = useContext(ctx)
  if (!value) throw new Error("useTheme must be used within a ThemeProvider")
  return value
}
