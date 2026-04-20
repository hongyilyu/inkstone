import { For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useAgent } from "../context/agent"
import { setScrollRef, refocusInput } from "../app"
import type { ScrollBoxRenderable } from "@opentui/core"

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

const SplitBorderChars = {
  ...EmptyBorder,
  vertical: "┃",
}

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
        <For each={store.messages}>
          {(msg, index) => (
            <Show when={msg.text}>
              <Show
                when={msg.role === "user"}
                fallback={
                  <box>
                    <text fg={theme.text}>{msg.text}</text>
                  </box>
                }
              >
                <box
                  border={["left"]}
                  borderColor={theme.secondary}
                  customBorderChars={SplitBorderChars}
                  marginTop={index() === 0 ? 0 : 1}
                >
                  <box
                    paddingTop={1}
                    paddingBottom={1}
                    paddingLeft={2}
                    backgroundColor={theme.backgroundPanel}
                    flexShrink={0}
                  >
                    <text fg={theme.text}>{msg.text}</text>
                  </box>
                </box>
              </Show>
            </Show>
          )}
        </For>
      </box>
    </scrollbox>
  )
}
