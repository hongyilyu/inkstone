import { useTheme } from "../context/theme"
import { refocusInput } from "../app"
import { VAULT_DIR } from "../agent/constants"
import pkg from "../../package.json"

/**
 * Session footer bar.
 * Modeled after OpenCode's routes/session/footer.tsx:
 * left = context path, right = status indicators (extensible via gap row).
 *
 * Intentionally omitted upstream right-side indicators (not applicable to inkstone):
 * - LSP connection count (no LSP integration)
 * - MCP server status (no MCP servers)
 * - Permission warnings (no permission system)
 * - /status command hint (no slash commands yet)
 * - "Get started /connect" welcome ticker (no connect flow)
 */
export function Footer() {
  const { theme } = useTheme()

  // Display vault path with ~ for home dir
  const vaultDisplay = VAULT_DIR.replace(/^\/home\/[^/]+/, "~")

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      gap={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      borderColor={theme.borderSubtle}
      border={["top"]}
      onMouseUp={() => setTimeout(() => refocusInput(), 1)}
    >
      <text fg={theme.textMuted}>{vaultDisplay}</text>
      <box gap={2} flexDirection="row" flexShrink={0}>
        <text fg={theme.textMuted}>{pkg.version}</text>
      </box>
    </box>
  )
}
