import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { loadConfig, saveConfig } from "../persistence/config";
import type { Config } from "../persistence/schema";
import { DEFAULT_PROVIDER, getProvider, resolveModel } from "../providers";
import { AGENTS, DEFAULT_AGENT, getAgentInfo } from "./agents";
import { composeSystemPrompt, composeTools } from "./compose";
import { dispatchBeforeToolCall, setConfirmFn } from "./permissions";
import type { AgentCommand, AgentInfo, AgentZone } from "./types";
import { composeOverlay } from "./zones";

/**
 * Actions exposed on a {@link Session}. Narrow on purpose: only
 * per-turn operations live here. Session lifecycle (`clearSession`,
 * `selectAgent`) lives on `Session` itself. Agent selection is NOT
 * here — the agent is fixed for a session's lifetime (see D13 in
 * `docs/AGENT-DESIGN.md`). To change agents, the TUI builds a new
 * session via `createSession`.
 */
export interface AgentActions {
	prompt(text: string): Promise<void>;
	abort(): void;
	setModel(model: Model<Api>): void;
	setThinkingLevel(level: ThinkingLevel): void;
}

/**
 * A live session — an `Agent` instance bound to a single agent name
 * for its whole lifetime, plus the actions the TUI drives.
 *
 * The raw `Agent` is deliberately NOT exposed on this shape. Callers
 * read model/thinking-level via the accessor methods; per-turn
 * operations go through `actions`; session lifecycle goes through
 * `clearSession` and `selectAgent`. Keeping the Agent encapsulated
 * matches D13 ("one agent per session") — there is no legitimate
 * caller-owned mutation of `agent.state.*` besides the ones this
 * façade performs.
 *
 * `selectAgent(name)` is an explicit escape hatch for the TUI's
 * empty-session agent picker (Tab / Ctrl+P → Agents / DialogAgent).
 * It throws when the session has any messages — swapping mid-flight
 * would silently break prompt-cache stability (systemPrompt + tools
 * change) and scramble per-bubble agent stamps. See D13.
 */
export interface Session {
	readonly actions: AgentActions;
	readonly agentName: string;
	getModel(): Model<Api>;
	getProviderId(): string;
	getModelId(): string;
	getThinkingLevel(): ThinkingLevel;
	/**
	 * Wipe the in-memory conversation. Leaves the underlying `Agent`
	 * instance, its system prompt, its tools, and its model alone —
	 * the session can continue with the same agent. The TUI wrapper
	 * additionally resets store-local state (messages, totals, session
	 * row id).
	 *
	 * Async because a mid-stream clear must first `abort()` the active
	 * run and wait for pi-agent-core's `agent_end` listeners to settle
	 * before `reset()` clears runtime fields. Without the await, a still-
	 * draining stream event can fire onto a wiped Agent, or leave
	 * `activeRun`/`isStreaming` pointing at a half-cleared state (see
	 * "Agent is already processing a prompt" on the next `prompt()`).
	 * Idle-session callers pay ~nothing because `waitForIdle()` resolves
	 * immediately when there's no active run.
	 */
	clearSession(): Promise<void>;
	/**
	 * Seed the Agent's conversation with a previously-persisted message
	 * list. Used by the resume-session path only.
	 *
	 * Caller must pass the full ordered conversation as returned by
	 * `loadSession().agentMessages`. pi-agent-core's contract assumes
	 * `state.messages` is a complete, ordered history — any gap or
	 * reorder silently corrupts prompt context on the next turn.
	 */
	restoreMessages(messages: AgentMessage[]): void;
	/**
	 * Swap the bound agent name. Only legal when the session has no
	 * messages yet. Rewrites `agent.state.systemPrompt` + `tools` so
	 * the next turn matches the new agent. Persists the choice so the
	 * next `createSession()` defaults to it.
	 *
	 * Throws if the session has messages; callers must clear first.
	 */
	selectAgent(name: string): void;
	/**
	 * Number of messages currently on the Agent's state. Used by the
	 * TUI wrapper to mirror emptiness checks (e.g. gating `selectAgent`)
	 * without exposing the raw Agent.
	 */
	readonly messageCount: number;
}

/**
 * Resolve the provider/model pair from config with the same fallback
 * chain as before the factory refactor:
 *   1. The stored `(providerId, modelId)` if it still resolves.
 *   2. The stored provider's curated default model.
 *   3. The default provider's default model (covers an OAuth provider
 *      whose creds have expired).
 *
 * We intentionally do NOT persist step-3 back to config via
 * `saveConfig` — the user's original pick stays on disk so a later
 * re-connect restores it without re-picking from DialogModel. The
 * in-memory flip is enough to boot against a working provider.
 */
function resolveInitialProviderModel(cfg: Config): {
	providerId: string;
	modelId: string;
} {
	const providerId = cfg.providerId ?? DEFAULT_PROVIDER;
	const stored = cfg.modelId;
	if (stored && resolveModel(providerId, stored)) {
		return { providerId, modelId: stored };
	}
	const info = getProvider(providerId);
	if (resolveModel(info.id, info.defaultModelId)) {
		return { providerId, modelId: info.defaultModelId };
	}
	if (providerId !== DEFAULT_PROVIDER) {
		const fallback = getProvider(DEFAULT_PROVIDER);
		if (resolveModel(fallback.id, fallback.defaultModelId)) {
			return { providerId: DEFAULT_PROVIDER, modelId: fallback.defaultModelId };
		}
	}
	throw new Error(
		`Default provider '${DEFAULT_PROVIDER}' default model is not available in the registry. ` +
			`Update the provider's \`defaultModelId\` or ensure pi-ai's registry still ships that model.`,
	);
}

function resolveInitialAgentName(cfg: Config, requested?: string): string {
	const candidate = requested ?? cfg.currentAgent;
	return candidate && AGENTS.some((a) => a.name === candidate)
		? candidate
		: DEFAULT_AGENT;
}

/**
 * ThinkingLevels the UI should offer for a model.
 *
 * Non-reasoning models have nothing to pick — the Effort palette entry is
 * hidden anyway. Reasoning models get the pi-agent-core set; `"xhigh"` is
 * gated on the model's own `thinkingLevelMap` (pi-ai 0.72+): a model
 * declares `xhigh: null` when it doesn't support the tier, any other value
 * (incl. missing) means it does. Replaces pi-ai's pre-0.72
 * `supportsXhigh()` helper, which was removed when the mapping moved from
 * an internal capability check to a per-model declarative field.
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
	// `thinkingLevelMap.xhigh === null` → model opts out of xhigh.
	// Missing map, missing key, or any non-null value → xhigh is offered.
	// Matches pi-ai's own collapse semantics for Opus 4.6 / 4.7, GPT-5.2+.
	if (model.thinkingLevelMap?.xhigh !== null) base.push("xhigh");
	return base;
}

/**
 * Build a {@link Session}: a pi-agent-core `Agent` plus the actions the
 * TUI drives, bound to a single agent name for the session's whole
 * lifetime. Replaces the previous module-level singleton + `getAgent`
 * + `createAgentActions` + `getCurrent*` surface.
 *
 * Parameters:
 *   - `agentName` — which agent's instructions/tools/zones to load. When
 *     omitted, falls back to `config.currentAgent`, then `DEFAULT_AGENT`.
 *     An unknown name coerces to `DEFAULT_AGENT` (matches the previous
 *     registry behavior).
 *   - `onEvent` — subscriber for pi-agent-core's `AgentEvent` stream.
 *
 * The `systemPrompt` is built once here and stays byte-stable for the
 * session's lifetime (see D9 in `docs/AGENT-DESIGN.md`). Anthropic
 * `cache_control` / Bedrock `cachePoint` are pinned to the byte-exact
 * system prefix, so dynamic per-turn context belongs in a user message
 * (reader's `/article` is the reference pattern), not here.
 */
export function createSession(params: {
	agentName?: string;
	onEvent: (event: AgentEvent) => void;
}): Session {
	const cfg = loadConfig();
	const initialInfo = getAgentInfo(
		resolveInitialAgentName(cfg, params.agentName),
	);
	// `info` drifts on `selectAgent`; everything after construction reads
	// this ref to pick up the current agent's zones/tools/instructions.
	let info: AgentInfo = initialInfo;

	// ── Model + thinking state ─────────────────────────────
	let providerSel = resolveInitialProviderModel(cfg);
	const initialModel = resolveModel(
		providerSel.providerId,
		providerSel.modelId,
	);
	if (!initialModel) {
		throw new Error(
			`Model '${providerSel.modelId}' is not available from provider '${providerSel.providerId}'.`,
		);
	}

	// Per-model reasoning effort, keyed by `${providerId}/${modelId}`.
	// Loaded from config at session start and mirrored back to config
	// on `setThinkingLevel`. Session-local (not module-level) so a
	// future second session can carry a different map without coupling.
	const thinkingLevels: Record<string, ThinkingLevel> = {
		...(cfg.thinkingLevels ?? {}),
	};
	function thinkingKey(providerId: string, modelId: string): string {
		return `${providerId}/${modelId}`;
	}
	function resolveThinkingLevel(model: Model<Api>): ThinkingLevel {
		return thinkingLevels[thinkingKey(model.provider, model.id)] ?? "off";
	}
	// ────────────────────────────────────────────────────────

	const agent = new Agent({
		initialState: {
			systemPrompt: composeSystemPrompt(info),
			model: initialModel,
			thinkingLevel: resolveThinkingLevel(initialModel),
			tools: composeTools(info),
		},
		getApiKey: async (provider) => {
			return getProvider(provider).getApiKey();
		},
		beforeToolCall: async (ctx) => {
			// Delegate to the permission dispatcher. The overlay combines
			// the zones-derived rules (directory write policies declared
			// on `AgentInfo.zones`) with the agent's optional `getPermissions`
			// escape hatch (rules zones can't express, e.g. reader's
			// `frontmatterOnlyInDirs` on the Articles zone).
			//
			// Reads the live `info` closure — after `selectAgent`, the
			// overlay reflects the new agent without needing to
			// reconstruct the Agent.
			const overlay = composeOverlay(info);
			return dispatchBeforeToolCall(ctx, overlay);
		},
	});

	agent.subscribe((event) => {
		params.onEvent(event);
	});

	const actions: AgentActions = {
		async prompt(text: string) {
			await agent.prompt(text);
		},
		abort() {
			agent.abort();
		},
		setModel(model: Model<Api>) {
			agent.state.model = model;
			providerSel = { providerId: model.provider, modelId: model.id };
			// Restore the effort previously picked for this model (or "off"
			// if none, or when the model is non-reasoning). Matches
			// OpenCode's per-model variant memory.
			agent.state.thinkingLevel = resolveThinkingLevel(model);
			saveConfig({ providerId: model.provider, modelId: model.id });
		},
		setThinkingLevel(level: ThinkingLevel) {
			agent.state.thinkingLevel = level;
			thinkingLevels[thinkingKey(providerSel.providerId, providerSel.modelId)] =
				level;
			// Persist the full map — `saveConfig` shallow-merges, so the
			// key addition/overwrite on this specific model survives
			// without clobbering other stored per-model levels.
			saveConfig({ thinkingLevels: { ...thinkingLevels } });
		},
	};

	return {
		actions,
		get agentName() {
			return info.name;
		},
		get messageCount() {
			return agent.state.messages.length;
		},
		getModel() {
			const m = resolveModel(providerSel.providerId, providerSel.modelId);
			if (!m)
				throw new Error(
					`Model '${providerSel.modelId}' is not available from provider '${providerSel.providerId}'.`,
				);
			return m;
		},
		getProviderId() {
			return providerSel.providerId;
		},
		getModelId() {
			return providerSel.modelId;
		},
		getThinkingLevel() {
			// Mirror `getModel`'s error surface: `providerSel` is always
			// a resolved pair post-construction (either the config's
			// stored pick or a fallback that validated via `resolveModel`),
			// so an unresolvable model here is an invariant violation.
			const m = resolveModel(providerSel.providerId, providerSel.modelId);
			if (!m)
				throw new Error(
					`Model '${providerSel.modelId}' is not available from provider '${providerSel.providerId}'.`,
				);
			return resolveThinkingLevel(m);
		},
		selectAgent(name: string) {
			// Empty-session invariant. See D13 in `docs/AGENT-DESIGN.md`.
			if (agent.state.messages.length > 0) {
				throw new Error(
					"Agent is fixed for the lifetime of a session. " +
						"Clear the session before selecting a different agent.",
				);
			}
			info = getAgentInfo(name);
			agent.state.systemPrompt = composeSystemPrompt(info);
			agent.state.tools = composeTools(info);
			saveConfig({ currentAgent: info.name });
		},
		async clearSession() {
			// `messages = []` alone leaks pi-agent-core runtime state
			// (`activeRun`, `isStreaming`, `streamingMessage`,
			// `pendingToolCalls`) on a mid-stream clear — the next
			// `prompt()` throws "Agent is already processing a prompt."
			// Use the library's own primitives: `abort()` cancels the
			// active run — the lifecycle's catch path runs
			// `handleRunFailure`, which synthesizes an aborted assistant
			// message and emits `agent_end` carrying it in `event.messages`
			// (no final `message_end`). The reducer's `agent_end` branch
			// already persists that message and sweeps pending tool
			// parts into error state. `waitForIdle()` resolves after
			// `agent_end` listeners settle so we don't stomp state
			// mid-drain; `reset()` clears transcript + runtime fields +
			// queued steering/follow-ups in one go. Idle-session path:
			// `signal` is undefined, `waitForIdle()` returns
			// `Promise.resolve()`, so the cost is one microtask.
			if (agent.state.isStreaming || agent.signal) {
				agent.abort();
				await agent.waitForIdle();
			}
			agent.reset();
		},
		restoreMessages(messages: AgentMessage[]) {
			agent.state.messages = messages;
		},
	};
}

export function listAgents(): AgentInfo[] {
	return AGENTS;
}

export {
	type AgentCommand,
	type AgentInfo,
	type AgentZone,
	getAgentInfo,
	setConfirmFn,
};
