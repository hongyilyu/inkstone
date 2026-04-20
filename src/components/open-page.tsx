import { useTheme } from "../context/theme"
import { Prompt } from "./prompt"
import { VAULT_DIR } from "../agent/constants"
import pkg from "../../package.json"

/**
 * Open page shown when no messages exist.
 * Centered layout with logo, prompt, and footer.
 * Matches OpenCode's routes/home.tsx:55-89 structure.
 */
export function OpenPage() {
  const { theme } = useTheme()

  // Display vault path with ~ for home dir
  const vaultDisplay = VAULT_DIR.replace(/^\/home\/[^/]+/, "~")

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      {/* Main centered content */}
      {/* Matches OpenCode home.tsx: flexGrow spacers + alignItems center */}
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />

        {/* Logo: "ink" (muted) + "stone" (primary) */}
        <box flexShrink={0} flexDirection="row">
          <ascii_font text="ink" font="block" color={theme.textMuted} />
          <ascii_font text="stone" font="block" color={theme.primary} />
        </box>

        <box height={1} minHeight={0} flexShrink={1} />

        {/* Prompt input area — max width 75, matches OpenCode home.tsx:66 */}
        <box width="100%" maxWidth={75} paddingTop={1} flexShrink={0}>
          <Prompt />
        </box>

        <box flexGrow={1} minHeight={0} />
      </box>

      {/* Footer: vault dir (left) + version (right) */}
      {/* Matches OpenCode feature-plugins/home/footer.tsx:57-74 */}
      <box
        width="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        flexShrink={0}
      >
        <text fg={theme.textMuted}>{vaultDisplay}</text>
        <box flexGrow={1} />
        <box flexShrink={0}>
          <text fg={theme.textMuted}>{pkg.version}</text>
        </box>
      </box>
    </box>
  )
}
