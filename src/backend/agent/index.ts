import { resolve } from "node:path";
import {
	Agent,
	type AgentEvent,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import { type Api, type Model, supportsXhigh } from "@mariozechner/pi-ai";
import { loadConfig, saveConfig } from "../persistence/config";
import { DEFAULT_PROVIDER, getProvider, resolveModel } from "../providers";
import { AGENTS, type AgentInfo, DEFAULT_AGENT, getAgentInfo } from "./agents";
import { ARTICLES_DIR } from "./constants";
import { beforeToolCall, setConfirmFn } from "./guard";
import { setActiveArticle } from "./tools/quote-article";

export interface AgentActions {
	prompt(text: string): Promise<void>;
	abort(): void;
	loadArticle(articleId: string): void;
	setModel(model: Model<Api>): void;
	setThinkingLevel(level: ThinkingLevel): void;
	setAgent(name: string): void;
	clearSession(): void;
}

let agent: Agent | null = null;
let activeArticle: string | null = null;

// Active provider/model. Both are resolved at module load from the on-disk
// config, falling back to the first registered provider's first model when
// unset (fresh install) or when the stored model no longer exists in the
// registry (e.g. a previous provider was removed).
const initialConfig = loadConfig();
let currentProviderId: string = initialConfig.providerId ?? DEFAULT_PROVIDER;
let currentModelId: string = (() => {
	const stored = initialConfig.modelId;
	if (stored && resolveModel(currentProviderId, stored)) return stored;
	// Fall back to the provider's explicit curated default, not to
	// `listModels()[0]`. The first entry in pi-ai's Bedrock model list is
	// `amazon.nova-2-lite-v1:0`, which would silently relocate fresh
	// installs (and any install whose stored id ever stops resolving) to
	// an arbitrary low-tier model.
	const info = getProvider(currentProviderId);
	if (resolveModel(info.id, info.defaultModelId)) return info.defaultModelId;
	throw new Error(
		`Provider '${info.id}' default model '${info.defaultModelId}' is not available in the registry. ` +
			`Update the provider's \`defaultModelId\` or ensure pi-ai's registry still ships that model.`,
	);
})();
let currentAgent: string = (() => {
	const stored = initialConfig.currentAgent;
	return stored && AGENTS.some((a) => a.name === stored)
		? stored
		: DEFAULT_AGENT;
})();

// Per-model reasoning effort, keyed by `${providerId}/${modelId}`. Persisted
// in `config.thinkingLevels`. Missing key == `"off"` (pi-agent-core's sentinel
// for "no reasoning"). Matches OpenCode's `local.model.variant` per-model
// keying so a model remembers the effort the user last picked for it.
const thinkingLevels: Record<string, ThinkingLevel> = {
	...(initialConfig.thinkingLevels ?? {}),
};

function thinkingKey(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

/**
 * Resolve the effective `ThinkingLevel` for a model. Falls back to `"off"`
 * when the user has not picked an effort for this model. pi-agent-core +
 * pi-ai already guard non-reasoning models (they return `undefined` for
 * thinking fields regardless of the level passed — see
 * `pi-mono/packages/ai/src/providers/amazon-bedrock.ts:623-625`), so we
 * don't re-check capability here.
 *
 * pi-ai also silently normalizes some levels at the wire (e.g. `"minimal"`
 * → `effort: "low"` on adaptive Claude). That's a pi-ai design choice —
 * the two levels produce the same model behavior — so we surface whatever
 * the user picked and let pi-ai map it.
 */
function resolveThinkingLevel(model: Model<Api>): ThinkingLevel {
	return thinkingLevels[thinkingKey(model.provider, model.id)] ?? "off";
}

function currentModel(): Model<Api> {
	const m = resolveModel(currentProviderId, currentModelId);
	if (!m)
		throw new Error(
			`Model '${currentModelId}' is not available from provider '${currentProviderId}'.`,
		);
	return m;
}

/**
 * ThinkingLevels the UI should offer for a model.
 *
 * Non-reasoning models have nothing to pick — the Effort palette entry is
 * hidden anyway. Reasoning models get the pi-agent-core set; `"xhigh"` is
 * gated on pi-ai's own `supportsXhigh()` capability helper (Opus 4.6/4.7,
 * GPT-5.2+).
 *
 * pi-ai may collapse some levels to the same wire value internally (e.g.
 * `"minimal"` → `effort: "low"` on adaptive Claude). That's intentional on
 * pi-ai's side — the collapsed levels produce identical model behavior, so
 * surfacing both in the picker is fine; the user's choice is still honored
 * semantically.
 */
export function availableThinkingLevels(model: Model<Api>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const base: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
	if (supportsXhigh(model)) base.push("xhigh");
	return base;
}

export function getAgent(): Agent {
	if (!agent) {
		const info = getAgentInfo(currentAgent);
		agent = new Agent({
			initialState: {
				systemPrompt: info.buildSystemPrompt(activeArticle),
				model: currentModel(),
				thinkingLevel: resolveThinkingLevel(currentModel()),
				tools: info.tools,
			},
			getApiKey: async (provider) => {
				return getProvider(provider).getApiKey();
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
			currentProviderId = model.provider;
			currentModelId = model.id;
			// Restore the effort previously picked for this model (or "off" if
			// none, or when the model is non-reasoning). Matches OpenCode's
			// per-model variant memory: switching back to a model re-applies
			// the effort the user last set for it.
			a.state.thinkingLevel = resolveThinkingLevel(model);
			saveConfig({ providerId: model.provider, modelId: model.id });
		},
		setThinkingLevel(level: ThinkingLevel) {
			a.state.thinkingLevel = level;
			thinkingLevels[thinkingKey(currentProviderId, currentModelId)] = level;
			// Persist the full map — `saveConfig` shallow-merges, so the key
			// addition/overwrite on this specific model survives without
			// clobbering other stored per-model levels.
			saveConfig({ thinkingLevels: { ...thinkingLevels } });
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

export function getCurrentProviderId(): string {
	return currentProviderId;
}

export function getCurrentModelId(): string {
	return currentModelId;
}

export function getCurrentModel(): Model<Api> {
	return currentModel();
}

export function getCurrentThinkingLevel(): ThinkingLevel {
	return resolveThinkingLevel(currentModel());
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
