import {
	Agent,
	type AgentEvent,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import { type Api, type Model, supportsXhigh } from "@mariozechner/pi-ai";
import { loadConfig, saveConfig } from "../persistence/config";
import { DEFAULT_PROVIDER, getProvider, resolveModel } from "../providers";
import { AGENTS, DEFAULT_AGENT, getAgentInfo } from "./agents";
import { getActiveArticle, setActiveArticle } from "./agents/reader";
import {
	type AgentCommand,
	type AgentCommandContext,
	type AgentInfo,
	type AgentZone,
	composeOverlay,
	composeSystemPrompt,
	composeTools,
} from "./base";
import { dispatchBeforeToolCall, setConfirmFn } from "./permissions";

export interface AgentActions {
	prompt(text: string): Promise<void>;
	abort(): void;
	setModel(model: Model<Api>): void;
	setThinkingLevel(level: ThinkingLevel): void;
	setAgent(name: string): void;
	clearSession(): void;
}

let agent: Agent | null = null;

// Active provider/model. Both are resolved at module load from the on-disk
// config, falling back to the first registered provider's first model when
// unset (fresh install) or when the stored model no longer exists in the
// registry (e.g. a previous provider was removed).
const initialConfig = loadConfig();
let currentProviderId: string = initialConfig.providerId ?? DEFAULT_PROVIDER;
let currentModelId: string = (() => {
	const stored = initialConfig.modelId;
	if (stored && resolveModel(currentProviderId, stored)) return stored;
	// Fall back to the stored provider's curated default if it still
	// resolves. Do NOT fall back to `listModels()[0]`, which is pi-ai-
	// registry-order-dependent (Nova 2 Lite today).
	const info = getProvider(currentProviderId);
	if (resolveModel(info.id, info.defaultModelId)) return info.defaultModelId;
	// The stored provider has nothing we can use — typically an OAuth
	// provider (e.g. Kiro) whose creds have been cleared or expired past
	// refresh. Fall through to the default provider so the app still
	// boots; the user can re-connect from the Connect palette.
	//
	// Note: we intentionally do NOT persist this fallback via saveConfig.
	// The stored `providerId` stays as the user's original pick, so the
	// next boot repeats this detection and re-connecting restores the
	// original selection without the user having to re-pick from
	// DialogModel. The in-memory `currentProviderId` flip is enough to
	// keep streaming pointed at a working provider until re-connect.
	if (currentProviderId !== DEFAULT_PROVIDER) {
		currentProviderId = DEFAULT_PROVIDER;
		const fallback = getProvider(DEFAULT_PROVIDER);
		if (resolveModel(fallback.id, fallback.defaultModelId)) {
			return fallback.defaultModelId;
		}
	}
	throw new Error(
		`Default provider '${DEFAULT_PROVIDER}' default model is not available in the registry. ` +
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
				systemPrompt: composeSystemPrompt(info),
				model: currentModel(),
				thinkingLevel: resolveThinkingLevel(currentModel()),
				tools: composeTools(info),
			},
			getApiKey: async (provider) => {
				return getProvider(provider).getApiKey();
			},
			beforeToolCall: async (ctx) => {
				// Delegate to the permission dispatcher. The overlay combines
				// the zones-derived rules (directory write policies declared
				// on `AgentInfo.zones`) with the agent's optional `getPermissions`
				// escape hatch (state-dependent rules zones can't express,
				// e.g. reader's `frontmatterOnlyFor` on the active article).
				// See `./base.ts:composeOverlay` + `./permissions.ts`.
				const overlay = composeOverlay(getAgentInfo(currentAgent));
				return dispatchBeforeToolCall(ctx, overlay);
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

	const actions: AgentActions = {
		async prompt(text: string) {
			// Rebuild the system prompt at every turn boundary so any
			// agent-owned state mutations (e.g. reader's `activeArticle`
			// set by `/article`) land in the next turn automatically.
			// This replaces the old explicit `refreshSystemPrompt()` call:
			// commands now just mutate state and call `ctx.prompt(...)`,
			// and the shell takes care of composing. Session restore, the
			// other former caller, relies on the same property — the first
			// user turn after boot rebuilds before sending.
			a.state.systemPrompt = composeSystemPrompt(getAgentInfo(currentAgent));
			await a.prompt(text);
		},
		abort() {
			a.abort();
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
			// Tools MUST be swapped immediately — pi-agent-core may serialize
			// them for the next request independently of when the system
			// prompt is read. System prompt is also refreshed here as a
			// mid-session correctness measure (something reading
			// `agent.state.systemPrompt` between turns would otherwise see
			// the previous agent's bytes). `prompt()` will rebuild again on
			// the next turn; that's fine, the output is byte-identical.
			a.state.systemPrompt = composeSystemPrompt(info);
			a.state.tools = composeTools(info);
			saveConfig({ currentAgent: info.name });
		},
		clearSession() {
			a.state.messages = [];
			// Reset reader-owned state. Other agents don't yet have state
			// that needs clearing; when they do, either (a) add similar
			// per-agent reset calls here or (b) introduce a lifecycle hook
			// on AgentInfo (e.g. `onSessionClear`) that the shell iterates.
			setActiveArticle(null);
			a.state.systemPrompt = composeSystemPrompt(getAgentInfo(currentAgent));
		},
	};

	return actions;
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

export function getCurrentAgent(): string {
	return currentAgent;
}

export function listAgents(): AgentInfo[] {
	return AGENTS;
}

export {
	type AgentCommand,
	type AgentCommandContext,
	type AgentInfo,
	type AgentZone,
	getActiveArticle,
	getAgentInfo,
	setActiveArticle,
	setConfirmFn,
};
