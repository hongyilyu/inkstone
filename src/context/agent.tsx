import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { batch } from "solid-js"
import { type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core"
import { createAgentActions, getAgent, setConfirmFn, type AgentActions } from "../agent"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { toBottom } from "../app"

interface AgentStoreState {
  messages: AgentMessage[]
  streamingText: string
  isStreaming: boolean
  activeArticle: string | null
  status: "idle" | "streaming" | "tool_executing"
}

interface AgentContextValue {
  store: AgentStoreState
  actions: AgentActions
}

const ctx = createContext<AgentContextValue>()

export function AgentProvider(props: ParentProps) {
  const dialog = useDialog()

  // Inject dialog-based confirm into the guard
  setConfirmFn(async (title, message) => {
    const result = await DialogConfirm.show(dialog, title, message)
    return result === true
  })

  const [store, setStore] = createStore<AgentStoreState>({
    messages: [],
    streamingText: "",
    isStreaming: false,
    activeArticle: null,
    status: "idle",
  })

  const actions = createAgentActions((event: AgentEvent) => {
    batch(() => {
      switch (event.type) {
        case "agent_start":
          setStore("isStreaming", true)
          setStore("status", "streaming")
          setStore("streamingText", "")
          // Snap to bottom so streaming text appears at the end
          toBottom()
          break

        case "message_update":
          if (
            "assistantMessageEvent" in event &&
            (event as any).assistantMessageEvent?.type === "text_delta"
          ) {
            setStore("streamingText", (t) => t + (event as any).assistantMessageEvent.delta)
          }
          break

        case "tool_execution_start":
          setStore("status", "tool_executing")
          break

        case "agent_end":
          setStore("isStreaming", false)
          setStore("status", "idle")
          setStore("messages", [...getAgent().state.messages])
          setStore("streamingText", "")
          break
      }
    })
  })

  const value: AgentContextValue = { store, actions }

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useAgent() {
  const value = useContext(ctx)
  if (!value) throw new Error("useAgent must be used within an AgentProvider")
  return value
}
