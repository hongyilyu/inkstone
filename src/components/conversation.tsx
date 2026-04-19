import { For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useAgent } from "../context/agent"
import { setScrollRef, refocusInput } from "../app"
import type { ScrollBoxRenderable } from "@opentui/core"

export function Conversation() {
  const { theme } = useTheme()
  const { store } = useAgent()

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => setScrollRef(r)}
      stickyScroll={true}
      stickyStart="bottom"
      flexGrow={1}
      onMouseUp={() => {
        // Prevent clicks in the conversation from stealing focus from input
        setTimeout(() => refocusInput(), 1)
      }}
    >
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
        <Show when={store.messages.length === 0 && !store.isStreaming}>
          <text fg={theme.textMuted}>
            Use /article filename.md to start reading an article.
          </text>
        </Show>

        <For each={store.messages}>
          {(msg) => (
            <Show when={msg.role === "user" || msg.role === "assistant"}>
              <box>
                <text fg={msg.role === "user" ? theme.info : theme.text}>
                  {msg.role === "user" ? "> " : ""}
                  {getMessageText(msg)}
                </text>
              </box>
            </Show>
          )}
        </For>

        <Show when={store.isStreaming && store.streamingText}>
          <box>
            <text fg={theme.text}>{store.streamingText}</text>
          </box>
        </Show>
      </box>
    </scrollbox>
  )
}

function getMessageText(msg: any): string {
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
  }
  return ""
}
