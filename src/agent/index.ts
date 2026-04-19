import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core"
import { getModel, type Model, type Api } from "@mariozechner/pi-ai"
import { resolve } from "path"
import { buildSystemPrompt } from "./prompt"
import { ARTICLES_DIR } from "./constants"
import { readFileTool } from "./tools/read-file"
import { editFileTool } from "./tools/edit-file"
import { writeFileTool } from "./tools/write-file"
import { quoteArticleTool, setActiveArticle } from "./tools/quote-article"
import { beforeToolCall, setConfirmFn } from "./guard"

export interface AgentActions {
  prompt(text: string): Promise<void>
  abort(): void
  loadArticle(articleId: string): void
  setModel(model: Model<Api>): void
  clearSession(): void
}

let agent: Agent | null = null
let activeArticle: string | null = null
let currentModelId: string = "us.anthropic.claude-sonnet-4-20250514-v1:0"

const tools = [readFileTool, editFileTool, writeFileTool, quoteArticleTool]

export function getAgent(): Agent {
  if (!agent) {
    agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(null),
        model: getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0"),
        thinkingLevel: "off",
        tools,
      },
      getApiKey: async (provider) => {
        if (provider === "amazon-bedrock") {
          return process.env.AWS_BEARER_TOKEN_BEDROCK
        }
        return undefined
      },
      beforeToolCall: async (ctx) => {
        // Inject article path into context for the guard
        const args = ctx.args as Record<string, any>
        if (activeArticle) {
          args._articlePath = resolve(ARTICLES_DIR, activeArticle)
        }
        return beforeToolCall(ctx)
      },
    })
  }
  return agent
}

export function createAgentActions(
  onEvent: (event: AgentEvent) => void,
): AgentActions {
  const a = getAgent()

  a.subscribe((event) => {
    onEvent(event)
  })

  return {
    async prompt(text: string) {
      await a.prompt(text)
    },
    abort() {
      a.abort()
    },
    loadArticle(articleId: string) {
      activeArticle = articleId
      setActiveArticle(articleId)
      a.state.systemPrompt = buildSystemPrompt(articleId)
    },
    setModel(model: Model<Api>) {
      a.state.model = model
      currentModelId = model.id
    },
    clearSession() {
      a.state.messages = []
      activeArticle = null
      setActiveArticle(null)
      a.state.systemPrompt = buildSystemPrompt(null)
    },
  }
}

export function getCurrentModelId(): string {
  return currentModelId
}

export function getActiveArticle(): string | null {
  return activeArticle
}

export { setConfirmFn }
