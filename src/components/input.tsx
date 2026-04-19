import { createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { useAgent } from "../context/agent"
import { ARTICLES_DIR } from "../agent/constants"

export function Input() {
  const { theme } = useTheme()
  const { actions, store } = useAgent()
  const [text, setText] = createSignal("")

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
        return
      }
    }

    actions.prompt(value)
    setText("")
  }

  return (
    <box
      borderColor={theme.border}
      border={["top"]}
      paddingLeft={1}
      paddingRight={1}
    >
      <input
        value={text()}
        onInput={(v: string) => setText(v)}
        onSubmit={handleSubmit}
        placeholder={store.isStreaming ? "Waiting for response..." : "Type a message or /article <filename>..."}
        focused
        backgroundColor={theme.background}
        textColor={theme.text}
        cursorColor={theme.primary}
        placeholderColor={theme.textMuted}
      />
    </box>
  )
}
