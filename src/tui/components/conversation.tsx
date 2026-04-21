import { For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useAgent } from "../context/agent"
import { setScrollRef, refocusInput } from "../app"
import { formatDuration } from "../util/format"
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
  const { theme, syntax } = useTheme()
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
      <box flexDirection="column" paddingTop={1} paddingRight={1} gap={1}>
        <For each={store.messages}>
          {(msg, index) => (
            <Show when={msg.text}>
              <Show
                when={msg.role === "user"}
                fallback={
                  <box flexDirection="column" flexShrink={0}>
                    <box paddingLeft={3} flexShrink={0}>
                      <markdown
                        content={msg.text}
                        syntaxStyle={syntax()}
                        streaming={store.isStreaming && index() === store.messages.length - 1}
                        fg={theme.text}
                        bg={theme.background}
                      />
                    </box>
                    <Show when={msg.modelName}>
                      <box paddingLeft={3} paddingTop={1} flexShrink={0}>
                        <text wrapMode="none">
                          <span style={{ fg: theme.secondary }}>{"▣ "}</span>
                          <span style={{ fg: theme.text }}>{msg.agentName ?? "Reader"}</span>
                          <span style={{ fg: theme.textMuted }}>
                            {" "}· {msg.modelName}
                            {msg.duration && msg.duration > 0 ? ` · ${formatDuration(msg.duration)}` : ""}
                          </span>
                        </text>
                      </box>
                    </Show>
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
