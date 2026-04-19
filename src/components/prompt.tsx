import { createSignal, createEffect, createMemo, Show, onMount, onCleanup } from "solid-js"
import { TextAttributes, type RGBA } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useAgent } from "../context/agent"
import { useDialog } from "../ui/dialog"
import { toBottom, setInputRef } from "../app"
import { formatTokens, formatCost } from "../util/format"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * Border chars matching OpenCode's EmptyBorder pattern.
 * All slots empty except horizontal (space) so borders render only where we want.
 */
const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

/**
 * Simple braille-dot spinner component.
 * Matches OpenCode's generic Spinner component (spinner.tsx).
 */
function Spinner(props: { color?: RGBA }) {
  const { theme } = useTheme()
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    const interval = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, 80)
    onCleanup(() => clearInterval(interval))
  })

  return <text fg={props.color ?? theme.textMuted}>{SPINNER_FRAMES[frame()]}</text>
}

/**
 * Unified prompt component used by both the open page and the session view.
 *
 * Structure matches OpenCode's Prompt component (prompt/index.tsx:973-1363):
 *   ┃ [input area]                            │
 *   ┃ Reader · Claude Sonnet 4  Amazon Bedrock│
 *   ╹
 *     [spinner / hints]    [usage / commands]
 */
export function Prompt() {
  const { theme } = useTheme()
  const { actions, store } = useAgent()
  const dialog = useDialog()
  const [text, setText] = createSignal("")

  let inputRef: any

  // Auto-focus: prompt always has focus unless a dialog is open
  // Mirrors OpenCode prompt/index.tsx:469-479
  createEffect(() => {
    const el = inputRef
    if (!el || el.isDestroyed) return
    if (dialog.stack.length > 0) {
      if (el.focused) el.blur()
      return
    }
    if (!el.focused) el.focus()
  })

  function handleSubmit() {
    const value = text().trim()
    if (!value) return
    if (store.isStreaming) return

    if (value === "/clear") {
      actions.clearSession()
      setText("")
      return
    }

    if (value.startsWith("/article ")) {
      const articleId = value.slice("/article ".length).trim()
      if (articleId) {
        actions.loadArticle(articleId)
        actions.prompt(`Read ${articleId}`)
        setText("")
        toBottom()
        return
      }
    }

    actions.prompt(value)
    setText("")
    toBottom()
  }

  // Usage display: "68.7K (7%) · $2.25"
  // Matches OpenCode's usage memo (prompt/index.tsx:159-176)
  const usageText = createMemo(() => {
    if (store.totalTokens <= 0) return undefined
    const tokens = formatTokens(store.totalTokens)
    const pct = store.contextWindow > 0
      ? ` (${Math.round((store.totalTokens / store.contextWindow) * 100)}%)`
      : ""
    const parts = [tokens + pct]
    if (store.totalCost > 0) {
      parts.push(formatCost(store.totalCost))
    }
    return parts.join(" · ")
  })

  const agentColor = theme.secondary

  return (
    <box>
      {/* Main input area with left border accent */}
      {/* Matches OpenCode prompt/index.tsx:974-981 */}
      <box
        border={["left"]}
        borderColor={agentColor}
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
          bottomLeft: "╹",
        }}
      >
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          flexShrink={0}
          backgroundColor={theme.backgroundElement}
          flexGrow={1}
        >
          <input
            ref={(r: any) => { inputRef = r; setInputRef(r) }}
            value={text()}
            onInput={(v: string) => setText(v)}
            onSubmit={handleSubmit}
            placeholder={store.isStreaming ? "Waiting for response..." : "Type a message or /article <filename>..."}
            focused
            backgroundColor={theme.backgroundElement}
            textColor={theme.text}
            cursorColor={store.isStreaming ? theme.backgroundElement : theme.primary}
            placeholderColor={theme.textMuted}
          />
          {/* Agent / Model metadata row */}
          {/* Matches OpenCode prompt/index.tsx:1186-1223 */}
          <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1}>
            <text fg={agentColor}>Reader</text>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.text}>{store.modelName}</text>
            <text fg={theme.textMuted}>{store.modelProvider}</text>
          </box>
        </box>
      </box>

      {/* Hints / status row below the input box */}
      {/* Matches OpenCode prompt/index.tsx:1252-1363 */}
      <box width="100%" flexDirection="row" justifyContent="space-between">
        {/* Left side: spinner when streaming, empty when idle */}
        <Show when={store.isStreaming} fallback={<text />}>
          <box flexDirection="row" gap={1} marginLeft={1}>
            <Spinner color={theme.textMuted} />
            <box flexDirection="row">
              <text fg={theme.text} attributes={TextAttributes.BOLD}>esc </text>
              <text fg={theme.textMuted}>interrupt</text>
            </box>
          </box>
        </Show>

        {/* Right side: usage stats or keybind hints */}
        {/* TODO: Implement proper keybind system with tab-based agent/command selection.
           Upstream reference: opencode/src/cli/cmd/tui/component/prompt/index.tsx:1333-1361
           Currently only ctrl+p (model selection) is bound in src/app.tsx:55. */}
        <box gap={2} flexDirection="row">
          <Show when={usageText()}>
            <text fg={theme.textMuted}>{usageText()}</text>
          </Show>
          <box flexDirection="row">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>ctrl+p </text>
            <text fg={theme.textMuted}>model</text>
          </box>
        </box>
      </box>
    </box>
  )
}
