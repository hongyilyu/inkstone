import { createContext, useContext, type ParentProps } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { batch } from "solid-js"
import { type AgentEvent } from "@mariozechner/pi-agent-core"
import { createAgentActions, getAgent, getCurrentModel, setConfirmFn, type AgentActions } from "../agent"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { toBottom } from "../app"
import type { Model, Api, AssistantMessage, Provider } from "@mariozechner/pi-ai"
import { saveSession, loadSession, clearSession as clearSessionFile } from "../persistence/session"

/** Map raw provider identifiers to display names */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  "amazon-bedrock": "Amazon Bedrock",
  "anthropic": "Anthropic",
  "openai": "OpenAI",
  "google": "Google",
  "google-vertex": "Google Vertex",
}

function formatProvider(provider: Provider): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider
}

export interface DisplayMessage {
  id: string
  role: "user" | "assistant"
  text: string
}

export interface LastTurnInfo {
  modelName: string
}

interface AgentStoreState {
  messages: DisplayMessage[]
  isStreaming: boolean
  activeArticle: string | null
  modelName: string
  modelProvider: string
  contextWindow: number
  status: "idle" | "streaming" | "tool_executing"
  totalTokens: number
  totalCost: number
  lastTurnStartedAt: number
  lastTurnDuration: number
  lastTurnInfo: LastTurnInfo | null
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

  // Get initial model info
  const initialModel = getCurrentModel()

  const [store, setStore] = createStore<AgentStoreState>({
    messages: saved?.messages ?? [],
    isStreaming: false,
    activeArticle: saved?.activeArticle ?? null,
    modelName: initialModel.name,
    modelProvider: formatProvider(initialModel.provider),
    contextWindow: initialModel.contextWindow,
    status: "idle",
    totalTokens: 0,
    totalCost: 0,
    lastTurnStartedAt: 0,
    lastTurnDuration: 0,
    lastTurnInfo: null,
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

        case "message_end": {
          // Accumulate token usage and cost from assistant messages
          const msg = (event as any).message
          if (msg && msg.role === "assistant") {
            const usage = (msg as AssistantMessage).usage
            if (usage) {
              setStore("totalTokens", (t) => t + usage.totalTokens)
              setStore("totalCost", (c) => c + usage.cost.total)
            }
            // Snapshot model name so the status line survives model switches
            setStore("lastTurnInfo", { modelName: store.modelName })
          }
          break
        }

        case "tool_execution_start":
          setStore("status", "tool_executing")
          break

        case "agent_end":
          setStore("isStreaming", false)
          setStore("status", "idle")
          if (store.lastTurnStartedAt > 0) {
            setStore("lastTurnDuration", Date.now() - store.lastTurnStartedAt)
          }
          // Persist session after each turn
          saveSession({
            messages: [...store.messages],
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
      setStore("lastTurnStartedAt", Date.now())
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
      setStore("modelProvider", formatProvider(model.provider))
      setStore("contextWindow", model.contextWindow)
    },
    clearSession() {
      actions.clearSession()
      setStore("messages", [])
      setStore("activeArticle", null)
      setStore("totalTokens", 0)
      setStore("totalCost", 0)
      setStore("lastTurnStartedAt", 0)
      setStore("lastTurnDuration", 0)
      setStore("lastTurnInfo", null)
      clearSessionFile()
      messageCounter = 0
    },
  }

  const value: AgentContextValue = { store, actions: wrappedActions }

  // Reactivate article-specific system prompt / guard in the agent runtime
  // if a previous session had an active article.
  if (saved?.activeArticle) {
    actions.loadArticle(saved.activeArticle)
  }

  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useAgent() {
  const value = useContext(ctx)
  if (!value) throw new Error("useAgent must be used within an AgentProvider")
  return value
}
