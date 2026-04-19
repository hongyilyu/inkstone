import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { batch } from "solid-js"
import { type AgentEvent } from "@mariozechner/pi-agent-core"
import { createAgentActions, getAgent, setConfirmFn, type AgentActions } from "../agent"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { toBottom } from "../app"
import type { Model, Api } from "@mariozechner/pi-ai"
import { saveSession, loadSession, clearSession as clearSessionFile } from "../persistence/session"
import { getCurrentModelId } from "../agent"

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  text: string
}

interface AgentStoreState {
  messages: DisplayMessage[]
  isStreaming: boolean
  activeArticle: string | null
  modelName: string
  status: "idle" | "streaming" | "tool_executing"
}

interface AgentContextValue {
  store: AgentStoreState
  actions: AgentActions
}

const ctx = createContext<AgentContextValue>()

let messageCounter = 0

export function AgentProvider(props: ParentProps) {
  const dialog = useDialog()

  setConfirmFn(async (title, message) => {
    const result = await DialogConfirm.show(dialog, title, message)
    return result === true
  })

  // Restore previous session if available
  const saved = loadSession()

  const [store, setStore] = createStore<AgentStoreState>({
    messages: saved?.messages ?? [],
    isStreaming: false,
    activeArticle: saved?.activeArticle ?? null,
    modelName: "Claude Sonnet 4",
    status: "idle",
  })

  // Set message counter past any restored messages
  if (saved?.messages) {
    messageCounter = saved.messages.length
  }

  const actions = createAgentActions((event: AgentEvent) => {
    batch(() => {
      switch (event.type) {
        case "agent_start":
          setStore("isStreaming", true)
          setStore("status", "streaming")
          // Push an empty assistant message — text will grow in place via deltas
          setStore("messages", produce((msgs) => {
            msgs.push({ id: `msg-${++messageCounter}`, role: "assistant", text: "" })
          }))
          toBottom()
          break

        case "message_update":
          if (
            "assistantMessageEvent" in event &&
            (event as any).assistantMessageEvent?.type === "text_delta"
          ) {
            const delta = (event as any).assistantMessageEvent.delta as string
            // Append delta to the last message's text — no array replacement
            setStore("messages", store.messages.length - 1, "text", (t) => t + delta)
          }
          break

        case "tool_execution_start":
          setStore("status", "tool_executing")
          break

        case "agent_end":
          setStore("isStreaming", false)
          setStore("status", "idle")
          // Persist session after each turn
          saveSession({
            messages: [...store.messages],
            modelId: getCurrentModelId(),
            activeArticle: store.activeArticle,
          })
          break
      }
    })
  })

  // Wrap prompt to add the user message to the store before calling the agent
  const wrappedActions: AgentActions = {
    ...actions,
    async prompt(text: string) {
      setStore("messages", produce((msgs) => {
        msgs.push({ id: `msg-${++messageCounter}`, role: "user", text })
      }))
      toBottom()
      await actions.prompt(text)
    },
    loadArticle(articleId: string) {
      actions.loadArticle(articleId)
      setStore("activeArticle", articleId)
    },
    setModel(model: Model<Api>) {
      actions.setModel(model)
      setStore("modelName", model.name)
    },
    clearSession() {
      actions.clearSession()
      setStore("messages", [])
      setStore("activeArticle", null)
      clearSessionFile()
      messageCounter = 0
    },
  }

  const value: AgentContextValue = { store, actions: wrappedActions }

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useAgent() {
  const value = useContext(ctx)
  if (!value) throw new Error("useAgent must be used within an AgentProvider")
  return value
}
