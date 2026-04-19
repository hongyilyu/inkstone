import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core"
import { getModel } from "@mariozechner/pi-ai"
import { buildSystemPrompt } from "./prompt"

export interface AgentActions {
  prompt(text: string): Promise<void>
  abort(): void
  loadArticle(articleId: string): void
}

export interface AgentState {
  messages: AgentMessage[]
  streamingText: string
  isStreaming: boolean
  activeArticle: string | null
  status: "idle" | "streaming" | "tool_executing"
}

let agent: Agent | null = null
let activeArticle: string | null = null

export function getAgent(): Agent {
  if (!agent) {
    agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(null),
        model: getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0"),
        thinkingLevel: "off",
        tools: [],
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
      a.state.systemPrompt = buildSystemPrompt(articleId)
    },
  }
}

export function getActiveArticle(): string | null {
  return activeArticle
}
