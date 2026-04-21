import { createMemo, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useAgent } from "../context/agent"
import { refocusInput } from "../app"
import { formatTokensFull, formatCost } from "../util/format"
import { VAULT_DIR } from "@backend/agent/constants"
import pkg from "../../../package.json"

const SIDEBAR_WIDTH = 30
// Inner content width = SIDEBAR_WIDTH - paddingLeft(2) - paddingRight(2)
const TITLE_MAX_CHARS = SIDEBAR_WIDTH - 4

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot > 0 ? filename.slice(0, dot) : filename
}

/**
 * Right-side session metadata panel.
 *
 * Layout:
 *   [title]        bold (active article, else first user msg, else "inkstone")
 *   Context        bold label
 *   tokens / % used / cost
 *   Article        bold label (only when an article is loaded)
 *   <filename>
 *   <spacer>
 *   vault path     muted
 *   version        muted
 */
export function Sidebar() {
  const { theme } = useTheme()
  const { store } = useAgent()

  // Display vault path with ~ for home dir (same substitution used in footer.tsx:22)
  const vaultDisplay = VAULT_DIR.replace(/^\/home\/[^/]+/, "~")

  const title = createMemo(() => {
    if (store.activeArticle) {
      return stripExtension(store.activeArticle).slice(0, TITLE_MAX_CHARS)
    }
    const firstUser = store.messages.find((m) => m.role === "user")
    if (firstUser?.text) {
      // Strip newlines so a multiline prompt doesn't blow up the title
      const flat = firstUser.text.replace(/\s+/g, " ").trim()
      return flat.slice(0, TITLE_MAX_CHARS)
    }
    return "inkstone"
  })

  const contextPct = createMemo(() => {
    if (store.contextWindow <= 0) return null
    return Math.round((store.totalTokens / store.contextWindow) * 100)
  })

  // Hide usage stats when counters are zeroed (e.g. reopened session where
  // totalTokens / totalCost were not persisted).
  const hasUsageData = createMemo(() => store.totalTokens > 0 || store.totalCost > 0)

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
      gap={1}
      onMouseUp={() => setTimeout(() => refocusInput(), 1)}
    >
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
          <text fg={theme.textMuted}>{formatCost(store.totalCost)} spent</text>
        </Show>
      </box>

      {/* Article (only when one is loaded) */}
      <Show when={store.activeArticle}>
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Article
          </text>
          <text fg={theme.textMuted}>{stripExtension(store.activeArticle!)}</text>
        </box>
      </Show>

      {/* Spacer pushes the bottom section down */}
      <box flexGrow={1} />

      {/* Bottom-anchored vault path + app/version */}
      <box flexDirection="column">
        <text fg={theme.textMuted} wrapMode="none">{vaultDisplay}</text>
        <box flexDirection="row" gap={1}>
          <text fg={theme.success}>•</text>
          <text fg={theme.textMuted}>InkStone {pkg.version}</text>
        </box>
      </box>
    </box>
  )
}
