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
        setTimeout(() => refocusInput(), 1)
      }}
    >
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
        <Show when={store.messages.length === 0}>
          <text fg={theme.textMuted}>
            Use /article filename.md to start reading an article.
          </text>
        </Show>

        <For each={store.messages}>
          {(msg) => (
            <Show when={msg.text}>
              <box>
                <text fg={msg.role === "user" ? theme.info : theme.text}>
                  {msg.role === "user" ? "> " : ""}
                  {msg.text}
                </text>
              </box>
            </Show>
          )}
        </For>
      </box>
    </scrollbox>
  )
}
