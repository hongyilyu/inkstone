import { resolve } from "node:path";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { loadConfig, saveConfig } from "../persistence/config";
import { ARTICLES_DIR } from "./constants";
import { beforeToolCall, setConfirmFn } from "./guard";
import { buildSystemPrompt } from "./prompt";
import { editFileTool } from "./tools/edit-file";
import { quoteArticleTool, setActiveArticle } from "./tools/quote-article";
import { readFileTool } from "./tools/read-file";
import { writeFileTool } from "./tools/write-file";

export interface AgentActions {
	prompt(text: string): Promise<void>;
	abort(): void;
	loadArticle(articleId: string): void;
	setModel(model: Model<Api>): void;
	clearSession(): void;
}

const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-20250514-v1:0";

let agent: Agent | null = null;
let activeArticle: string | null = null;
let currentModelId: string = loadConfig().modelId ?? DEFAULT_MODEL_ID;

const tools = [readFileTool, editFileTool, writeFileTool, quoteArticleTool];

export function getAgent(): Agent {
	if (!agent) {
		agent = new Agent({
			initialState: {
				systemPrompt: buildSystemPrompt(null),
				model: getModel("amazon-bedrock", currentModelId as any),
				thinkingLevel: "off",
				tools,
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
			a.state.systemPrompt = buildSystemPrompt(articleId);
		},
		setModel(model: Model<Api>) {
			a.state.model = model;
			currentModelId = model.id;
			saveConfig({ modelId: model.id });
		},
		clearSession() {
			a.state.messages = [];
			activeArticle = null;
			setActiveArticle(null);
			a.state.systemPrompt = buildSystemPrompt(null);
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

export { setConfirmFn };
