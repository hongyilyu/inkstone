import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { loadConfig, saveConfig } from "../persistence/config";
import type { Config } from "../persistence/schema";
import { getProvider, resolveModel } from "../providers";
import { AGENTS, DEFAULT_AGENT, getAgentInfo } from "./agents";
import { composeSystemPrompt, composeTools } from "./compose";
import {
	dispatchBeforeToolCall,
	getConfirmFn,
	setConfirmFn,
} from "./permissions";
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
	 * Set the session id forwarded to providers for cache-aware
	 * backends. Pi-agent-core stamps this onto every stream call as
	 * `SimpleStreamOptions.sessionId`; the `openai-codex-responses`
	 * provider uses it as both the `prompt_cache_key` (SSE) and the
	 * WebSocket connection cache key. Reusing the same id across
	 * turns in one Inkstone session lets pi-ai's `websocket-cached`
	 * path (via the `"auto"` transport default) skip re-sending full
	 * context after the first turn.
	 *
	 * Called lazily from the TUI's `ensureSession()` on first prompt,
	 * since the SQLite session row id isn't known at `createSession`
	 * time. Idempotent — assigning the same id repeatedly is a no-op.
	 * Only the Codex provider reads it today; other providers ignore it.
	 */
	setSessionId(id: string): void;
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
	/**
	 * Tear down the pi-agent-core subscription installed in
	 * `createSession`. Call on provider unmount so the backend Agent
	 * stops holding a strong reference to the (now-disposed) frontend
	 * event handler. Without this, re-mounting `AgentProvider` (tests,
	 * future HMR) would leak listeners + pin the disposed Solid owner
	 * tree against GC.
	 */
	dispose(): void;
}

/**
 * Resolve the provider/model pair from config:
 *   1. The stored `(providerId, modelId)` if it still resolves.
 *   2. The stored provider's curated default model.
 *   3. Throw — no provider is connected, user must open Connect.
 *
 * We intentionally do NOT persist a fallback back to config via
 * `saveConfig` — the user's original pick stays on disk so a later
 * re-connect restores it without re-picking from DialogModel.
 *
 * Before Amazon Bedrock was dropped, a third fallback case existed: if
 * the stored provider's default didn't resolve, we'd jump to
 * `DEFAULT_PROVIDER` (Bedrock). Bedrock would typically self-connect via
 * `~/.aws/` credentials, so fresh boots "just worked." With every shipped
 * provider now requiring explicit user credentials, that silent-fallback
 * path is gone — a fresh install with no stored config throws, and the
 * TUI surfaces the error nudging the user to Connect.
 */
function resolveInitialProviderModel(cfg: Config): {
	providerId: string;
	modelId: string;
} {
	const providerId = cfg.providerId;
	if (providerId) {
		const stored = cfg.modelId;
		if (stored && resolveModel(providerId, stored)) {
			return { providerId, modelId: stored };
		}
		const info = getProvider(providerId);
		if (info && resolveModel(info.id, info.defaultModelId)) {
			return { providerId, modelId: info.defaultModelId };
		}
	}
	throw new Error(
		"No provider is connected. Open Connect (Ctrl+P → /connect) to sign in to Kiro, ChatGPT, or OpenRouter.",
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
		// `transport: "auto"` is pi-ai 0.72.x's default for `openai-codex-
		// responses` anyway (`providers/openai-codex-responses.js:92`);
		// setting it explicitly pins the behavior against future pi-ai
		// default flips and documents the choice at the Agent level.
		// "auto" tries WebSocket first, silently falls back to SSE on
		// connection failure — connectivity over cost, per the stack-
		// plan decision. Non-Codex providers ignore the option. The
		// one-shot "using SSE fallback" toast lives TUI-side (see
		// `tui/context/agent.tsx`'s `agent_end` handler); detection
		// reads `getOpenAICodexWebSocketDebugStats(sessionId)`.
		transport: "auto",
		getApiKey: async (provider) => {
			// pi-agent-core calls this hook with the provider id from the
			// active `Model<Api>`. The model came from `resolveModel` →
			// `getProvider`, so the provider is registered by construction;
			// `undefined` here means someone handed us a model from a
			// dropped provider (e.g. post-Bedrock-drop session restore
			// against a stale config row), which is a clean
			// no-creds-available signal. Returning undefined lets pi-ai
			// surface the downstream error through the existing error path.
			return getProvider(provider)?.getApiKey();
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

	// Capture the subscribe dispose handle. pi-agent-core returns a
	// unsubscribe fn from `agent.subscribe`; holding it here lets the
	// frontend tear the wiring down on provider unmount so the Agent
	// doesn't keep a strong ref to a disposed event handler. See
	// `Session.dispose` below for the teardown call site.
	const unsubscribe = agent.subscribe((event) => {
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
		setSessionId(id: string) {
			agent.sessionId = id;
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
		dispose() {
			unsubscribe();
		},
	};
}

export function listAgents(): AgentInfo[] {
	return AGENTS;
}

export { generateSessionTitle } from "./session-title";
export {
	type AgentCommand,
	type AgentInfo,
	type AgentZone,
	getAgentInfo,
	getConfirmFn,
	setConfirmFn,
};
