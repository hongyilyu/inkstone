import { resolve } from "node:path";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { loadConfig, saveConfig } from "../persistence/config";
import { AGENTS, type AgentInfo, DEFAULT_AGENT, getAgentInfo } from "./agents";
import { ARTICLES_DIR } from "./constants";
import { beforeToolCall, setConfirmFn } from "./guard";
import { setActiveArticle } from "./tools/quote-article";

export interface AgentActions {
	prompt(text: string): Promise<void>;
	abort(): void;
	loadArticle(articleId: string): void;
	setModel(model: Model<Api>): void;
	setAgent(name: string): void;
	clearSession(): void;
}

const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-20250514-v1:0";

let agent: Agent | null = null;
let activeArticle: string | null = null;
let currentModelId: string = loadConfig().modelId ?? DEFAULT_MODEL_ID;
let currentAgent: string = (() => {
	const stored = loadConfig().currentAgent;
	return stored && AGENTS.some((a) => a.name === stored)
		? stored
		: DEFAULT_AGENT;
})();

export function getAgent(): Agent {
	if (!agent) {
		const info = getAgentInfo(currentAgent);
		agent = new Agent({
			initialState: {
				systemPrompt: info.buildSystemPrompt(activeArticle),
				model: getModel("amazon-bedrock", currentModelId as any),
				thinkingLevel: "off",
				tools: info.tools,
			},
			getApiKey: async (provider) => {
				if (provider === "amazon-bedrock") {
					return process.env.AWS_BEARER_TOKEN_BEDROCK;
				}
				return undefined;
			},
			beforeToolCall: async (ctx) => {
				// Inject article path into context for the guard
				const args = ctx.args as Record<string, any>;
				if (activeArticle) {
					args._articlePath = resolve(ARTICLES_DIR, activeArticle);
				}
				return beforeToolCall(ctx);
			},
		});
	}
	return agent;
}

export function createAgentActions(
	onEvent: (event: AgentEvent) => void,
): AgentActions {
	const a = getAgent();

	a.subscribe((event) => {
		onEvent(event);
	});

	return {
		async prompt(text: string) {
			await a.prompt(text);
		},
		abort() {
			a.abort();
		},
		loadArticle(articleId: string) {
			activeArticle = articleId;
			setActiveArticle(articleId);
			// Rebuild the system prompt through whichever agent is currently active.
			// In practice only the reader agent reads `activeArticle` — other agents
			// silently ignore the argument.
			a.state.systemPrompt =
				getAgentInfo(currentAgent).buildSystemPrompt(activeArticle);
		},
		setModel(model: Model<Api>) {
			a.state.model = model;
			currentModelId = model.id;
			saveConfig({ modelId: model.id });
		},
		setAgent(name: string) {
			const info = getAgentInfo(name);
			currentAgent = info.name;
			a.state.systemPrompt = info.buildSystemPrompt(activeArticle);
			a.state.tools = info.tools;
			saveConfig({ currentAgent: info.name });
		},
		clearSession() {
			a.state.messages = [];
			activeArticle = null;
			setActiveArticle(null);
			a.state.systemPrompt = getAgentInfo(currentAgent).buildSystemPrompt(null);
		},
	};
}

export function getCurrentModelId(): string {
	return currentModelId;
}

export function getCurrentModel(): Model<Api> {
	return getModel("amazon-bedrock", currentModelId as any);
}

export function getActiveArticle(): string | null {
	return activeArticle;
}

export function getCurrentAgent(): string {
	return currentAgent;
}

export function listAgents(): AgentInfo[] {
	return AGENTS;
}

export { type AgentInfo, getAgentInfo, setConfirmFn };
