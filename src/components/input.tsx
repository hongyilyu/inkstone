import { createSignal, createEffect } from "solid-js"
import { useTheme } from "../context/theme"
import { useAgent } from "../context/agent"
import { useDialog } from "../ui/dialog"
import { toBottom } from "../app"

export function Input() {
  const { theme } = useTheme()
  const { actions, store } = useAgent()
  const dialog = useDialog()
  const [text, setText] = createSignal("")

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

  let inputRef: any

  function handleSubmit() {
    const value = text().trim()
    if (!value) return
    if (store.isStreaming) return

    // Handle /article command
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

  return (
    <box
      borderColor={theme.border}
      border={["top"]}
      paddingLeft={1}
      paddingRight={1}
    >
      <input
        ref={(r: any) => (inputRef = r)}
        value={text()}
        onInput={(v: string) => setText(v)}
        onSubmit={handleSubmit}
        placeholder={store.isStreaming ? "Waiting for response..." : "Type a message or /article <filename>..."}
        focused
        backgroundColor={theme.background}
        textColor={theme.text}
        cursorColor={store.isStreaming ? theme.backgroundElement : theme.primary}
        placeholderColor={theme.textMuted}
      />
    </box>
  )
}
