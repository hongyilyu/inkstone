import { useTheme } from "../context/theme"
import { refocusInput } from "../app"
import { VAULT_DIR } from "../agent/constants"
import pkg from "../../package.json"

/**
 * Footer bar shown in the session (conversation) view.
 * Displays vault directory path (left) and version (right).
 * Matches OpenCode's feature-plugins/home/footer.tsx pattern.
 */
export function Footer() {
  const { theme } = useTheme()

  // Display vault path with ~ for home dir
  const vaultDisplay = VAULT_DIR.replace(/^\/home\/[^/]+/, "~")

  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      borderColor={theme.borderSubtle}
      border={["top"]}
      onMouseUp={() => setTimeout(() => refocusInput(), 1)}
    >
      <text fg={theme.textMuted}>{vaultDisplay}</text>
      <box flexGrow={1} />
      <box flexShrink={0}>
        <text fg={theme.textMuted}>{pkg.version}</text>
      </box>
    </box>
  )
}
