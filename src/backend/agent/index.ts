import type { SessionSnapshot } from "@bridge/view-model";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	resolveAgentModel,
	resolveAgentThinkingLevel,
	setAgentModel,
	setAgentThinkingLevel,
} from "../persistence/agent-config";
import { loadConfig, saveConfig } from "../persistence/config";
import type { ModelRef } from "../persistence/schema";
import { getProvider, listProviders, resolveModel } from "../providers";
import { AGENTS, DEFAULT_AGENT, getAgentInfo } from "./agents";
import { composeSystemPrompt, composeTools } from "./compose";
import {
	dispatchBeforeToolCall,
	getConfirmFn,
	setConfirmFn,
} from "./permissions";
import {
	getSuggestCommandFn,
	type SuggestCommandDecision,
	type SuggestCommandRequest,
	setSuggestCommandFn,
} from "./tools/suggest-command";
import type { AgentCommand, AgentInfo, AgentZone } from "./types";
import { composeOverlay } from "./zones";

// Per-turn operations the TUI drives. Lifecycle (`clearSession`,
// `selectAgent`) lives on `Session` itself — see `docs/AGENT-DESIGN.md`
// D13 for why agent selection isn't a runtime action.
export interface AgentActions {
	prompt(text: string): Promise<void>;
	abort(): void;
	setModel(model: Model<Api>): void;
	setThinkingLevel(level: ThinkingLevel): void;
	/**
	 * Remove the active agent's per-agent model override so the agent
	 * re-inherits the top-level default. Resolves the new effective
	 * model immediately and applies it to the live agent state — same
	 * shape as `setModel`, just with `null` as the persisted value.
	 *
	 * Used by `DialogModel`'s "Use default" entry (see plan D7a). When
	 * the active agent has no per-agent override to begin with, this
	 * is a no-op-equivalent — the resolution chain falls through to
	 * the top-level value either way.
	 */
	clearAgentModel(): void;
	/**
	 * Remove the active agent's per-agent thinking-level override for
	 * the *currently active model only*. Other models the agent has
	 * customized retain their per-agent values. The agent's effective
	 * level for the active model falls back to the top-level
	 * `thinkingLevels` map, then to "off".
	 */
	clearAgentThinkingLevel(): void;
}

// Live session façade. Wraps a pi-agent-core `Agent` bound to one
// agent name for its lifetime; raw `Agent` deliberately not exposed.
// `selectAgent(name)` only works on empty sessions (D13).
export interface Session {
	readonly actions: AgentActions;
	readonly agentName: string;
	getModel(): Model<Api>;
	getProviderId(): string;
	getModelId(): string;
	getThinkingLevel(): ThinkingLevel;
	/**
	 * Reactive projection consumed by the TUI provider. Produces the
	 * single shape the store mirrors so action bodies don't hand-fan
	 * five `setStore(...)` lines per mutation — see `SessionSnapshot`
	 * in `@bridge/view-model` for the field-by-field rationale.
	 */
	snapshot(): SessionSnapshot;
	/**
	 * Register `cb` to fire after every snapshot mutation
	 * (`setModel` / `setThinkingLevel` / `clearAgentModel` /
	 * `clearAgentThinkingLevel` / `selectAgent`). Returns the
	 * unsubscribe handle. Initial state is NOT delivered through
	 * subscribe; the caller seeds from `snapshot()` at construction
	 * time, mirroring pi-agent-core's `Agent.subscribe` shape.
	 */
	subscribe(cb: (next: SessionSnapshot) => void): () => void;
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
 * Resolve a `(providerId, modelId)` pair given a possible reference:
 *   1. If `ref` is non-null and points to a model that still resolves,
 *      use it.
 *   2. If `ref` names a known provider whose curated default model
 *      resolves, use that default.
 *   3. If `ref` is null, fall through to the first connected provider's
 *      curated default — gives fresh installs a working pick without
 *      forcing the user to open the model dialog.
 *   4. Throw — no provider is connected.
 *
 * Used both for the initial session boot (per-agent ref → top-level →
 * null) and for any future call site that resolves a `ModelRef`.
 */
function resolveModelRef(ref: ModelRef | null): {
	providerId: string;
	modelId: string;
} {
	if (ref) {
		if (resolveModel(ref.providerId, ref.modelId)) {
			return { providerId: ref.providerId, modelId: ref.modelId };
		}
		const info = getProvider(ref.providerId);
		if (info && resolveModel(info.id, info.defaultModelId)) {
			// Stored ref's model id no longer resolves (e.g. pi-ai
			// dropped it from the registry, or the provider's catalog
			// changed). Fall back to the same provider's curated
			// default. Quiet warning so a user who notices their
			// model "switched" has a breadcrumb in stderr.
			console.warn(
				`[inkstone] config model '${ref.providerId}/${ref.modelId}' did not resolve; using provider default '${info.defaultModelId}'`,
			);
			return { providerId: info.id, modelId: info.defaultModelId };
		}
		// Stored ref pointed at a provider that's currently disconnected
		// (or unknown to the registry). Fall through to the
		// first-connected loop below; warn so the silent-switch isn't
		// completely opaque.
		console.warn(
			`[inkstone] config provider '${ref.providerId}' is not connected; falling back to first connected provider`,
		);
	}
	for (const info of listProviders()) {
		if (info.isConnected() && resolveModel(info.id, info.defaultModelId)) {
			return { providerId: info.id, modelId: info.defaultModelId };
		}
	}
	throw new Error(
		"No provider is connected. Open Connect (Ctrl+P → /connect) to sign in to Kiro, ChatGPT, or OpenRouter.",
	);
}

function resolveInitialAgentName(requested?: string): string {
	return requested && AGENTS.some((a) => a.name === requested)
		? requested
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
 *     omitted, falls back to `DEFAULT_AGENT`. An unknown name also
 *     coerces to `DEFAULT_AGENT`. Resume callers pass the recorded
 *     agent name from the session row directly.
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
	const initialInfo = getAgentInfo(resolveInitialAgentName(params.agentName));
	// `info` drifts on `selectAgent`; everything after construction reads
	// this ref to pick up the current agent's zones/tools/instructions.
	let info: AgentInfo = initialInfo;

	// ── Model + thinking state ─────────────────────────────
	// Per-agent override -> top-level default -> first-connected-provider
	// default. The agent's effective model is bound at construction; a
	// later `setModel` call writes through to `agents.<active>.model` so
	// switching back to this agent later restores its pick.
	let providerSel = resolveModelRef(resolveAgentModel(cfg, info.name));
	const initialModel = resolveModel(
		providerSel.providerId,
		providerSel.modelId,
	);
	if (!initialModel) {
		throw new Error(
			`Model '${providerSel.modelId}' is not available from provider '${providerSel.providerId}'.`,
		);
	}

	function resolveThinkingLevelFor(model: Model<Api>): ThinkingLevel {
		return resolveAgentThinkingLevel(
			loadConfig(),
			info.name,
			model.provider,
			model.id,
		);
	}

	// Snapshot subscribers. Action bodies call `notify()` after the
	// `(agent.state.*, providerSel, info)` triple is coherent so the
	// TUI provider sees one consistent fan-out per mutation rather
	// than the previous five hand-mirrored `setStore` calls.
	const subscribers = new Set<(next: SessionSnapshot) => void>();
	function buildSnapshot(): SessionSnapshot {
		const m = agent.state.model;
		return {
			agentName: info.name,
			modelName: m.name,
			modelProvider: m.provider,
			contextWindow: m.contextWindow,
			modelReasoning: m.reasoning,
			thinkingLevel: agent.state.thinkingLevel,
		};
	}
	function notify(): void {
		const snap = buildSnapshot();
		for (const cb of subscribers) cb(snap);
	}
	// ────────────────────────────────────────────────────────

	// Hoist the composed tool list so the same array is handed to
	// pi-agent-core AND captured by the `beforeToolCall` closure
	// below — single source of truth for "what tools this session has."
	// `let` because `selectAgent` rebinds on agent swap (the Agent's
	// `state.tools` is reassigned alongside).
	let tools = composeTools(info);

	const agent = new Agent({
		initialState: {
			systemPrompt: composeSystemPrompt(info),
			model: initialModel,
			thinkingLevel: resolveThinkingLevelFor(initialModel),
			tools,
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
			// Delegate to the permission dispatcher. `tools` is captured
			// once at session construction and rebound by `selectAgent`
			// on agent swap — baselines are static data on the tool, so
			// a per-call rebuild is unnecessary. `composeOverlay(info)`
			// re-evaluates per call so `getPermissions()` can return
			// state-dependent rules fresh for each dispatch.
			//
			// The overlay combines the zones-derived rules (directory
			// write policies declared on `AgentInfo.zones`) with the
			// agent's optional `getPermissions` escape hatch (rules
			// zones can't express, e.g. reader's `frontmatterOnlyInDirs`
			// on the Articles zone).
			const overlay = composeOverlay(info);
			return dispatchBeforeToolCall(ctx, tools, overlay);
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
			// pi-agent-core rejects a second `prompt()` while a run is
			// active. For concurrent user-turn requests (today: the
			// post-confirm replay from `suggest_command`), route through
			// the library's designed primitive — `followUp` enqueues
			// the message and the agent-loop drains it via
			// `getFollowUpMessages()` at the natural end of the current
			// run (see `agent-loop.js:136-141`). The error pi-agent-core
			// throws on the second `prompt()` literally instructs the
			// caller to use `steer()` or `followUp()`; we're taking
			// that path.
			//
			// `agent.signal` is a thin getter over `activeRun?.signal`
			// — truthy iff `activeRun` is set. Tighter than
			// `isStreaming`, which can be clear while `finishRun` is
			// still running in the lifecycle's `finally`.
			//
			// The followUp branch is fire-and-forget on purpose:
			// `agent.followUp` is synchronous (just enqueues); the drain
			// + turn run happens inside the current loop's outer
			// iteration, so there's no meaningful Promise to await here.
			// The existing pre-stream-error catch in `promptAction`
			// depends on `agent.prompt` rejecting synchronously on
			// getApiKey failure etc; followUp errors surface through
			// `message_end` / `agent_end` like any other loop error.
			if (agent.signal) {
				agent.followUp({
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				});
				return;
			}
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
			// OpenCode's per-model variant memory. Reads from disk so a
			// concurrent `/effort` write isn't lost.
			agent.state.thinkingLevel = resolveThinkingLevelFor(model);
			// Persist as a per-agent override. Top-level `cfg.model` only
			// changes when the user hand-edits `config.json`; agents that
			// have not customized continue to inherit from there.
			saveConfig(
				setAgentModel(loadConfig(), info.name, {
					providerId: model.provider,
					modelId: model.id,
				}),
			);
			notify();
		},
		setThinkingLevel(level: ThinkingLevel) {
			agent.state.thinkingLevel = level;
			// Persist as a per-agent override keyed by the active model.
			saveConfig(
				setAgentThinkingLevel(
					loadConfig(),
					info.name,
					providerSel.providerId,
					providerSel.modelId,
					level,
				),
			);
			notify();
		},
		clearAgentModel() {
			// Drop the per-agent override and re-resolve the effective
			// model. Resolution falls through to top-level `cfg.model`,
			// then to the first connected provider's default. The live
			// agent state is updated to match so the next turn runs on
			// the new pair without an extra pick.
			const nextCfg = setAgentModel(loadConfig(), info.name, null);
			saveConfig(nextCfg);
			const ref = resolveAgentModel(nextCfg, info.name);
			const next = resolveModelRef(ref);
			const nextModel = resolveModel(next.providerId, next.modelId);
			if (!nextModel) {
				throw new Error(
					`Model '${next.modelId}' is not available from provider '${next.providerId}'.`,
				);
			}
			providerSel = next;
			agent.state.model = nextModel;
			agent.state.thinkingLevel = resolveThinkingLevelFor(nextModel);
			notify();
		},
		clearAgentThinkingLevel() {
			// Per-model granularity: drop only the (active provider,
			// active model) entry from this agent's thinkingLevels.
			// Other (provider,model) overrides this agent has set stay
			// intact. The live agent state is updated to whatever the
			// resolution chain resolves to (top-level entry for this
			// (provider,model) key, else "off").
			const nextCfg = setAgentThinkingLevel(
				loadConfig(),
				info.name,
				providerSel.providerId,
				providerSel.modelId,
				null,
			);
			saveConfig(nextCfg);
			agent.state.thinkingLevel = resolveAgentThinkingLevel(
				nextCfg,
				info.name,
				providerSel.providerId,
				providerSel.modelId,
			);
			notify();
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
			return resolveThinkingLevelFor(m);
		},
		selectAgent(name: string) {
			// Empty-session invariant. See D13 in `docs/AGENT-DESIGN.md`.
			if (agent.state.messages.length > 0) {
				throw new Error(
					"Agent is fixed for the lifetime of a session. " +
						"Clear the session before selecting a different agent.",
				);
			}
			// Agent selection is not persisted (plan D8). Fresh launches
			// start at DEFAULT_AGENT; resume reads the agent name from
			// the SQLite session row. Switching the bound agent also
			// flips the effective model + thinking level to the
			// destination agent's resolved values, so subsequent turns
			// run with the right (provider, model, effort) tuple
			// without an extra round-trip through the dialogs.
			//
			// Resolve everything BEFORE mutating any state. If
			// `resolveModelRef` throws (e.g. provider got disconnected
			// mid-session), the session stays bound to the old agent
			// rather than landing in a torn "info points at new agent
			// but model is still the old one" state.
			const nextInfo = getAgentInfo(name);
			const ref = resolveAgentModel(loadConfig(), nextInfo.name);
			const nextProviderSel = resolveModelRef(ref);
			const nextModel = resolveModel(
				nextProviderSel.providerId,
				nextProviderSel.modelId,
			);
			if (!nextModel) {
				throw new Error(
					`Model '${nextProviderSel.modelId}' is not available from provider '${nextProviderSel.providerId}'.`,
				);
			}
			info = nextInfo;
			providerSel = nextProviderSel;
			agent.state.systemPrompt = composeSystemPrompt(info);
			// Rebind the closure-captured `tools` alongside the Agent's
			// own `state.tools` so the `beforeToolCall` dispatcher
			// resolves baselines against the new agent's tool set.
			tools = composeTools(info);
			agent.state.tools = tools;
			agent.state.model = nextModel;
			agent.state.thinkingLevel = resolveThinkingLevelFor(nextModel);
			notify();
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
		snapshot() {
			return buildSnapshot();
		},
		subscribe(cb) {
			subscribers.add(cb);
			return () => {
				subscribers.delete(cb);
			};
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
	getSuggestCommandFn,
	type SuggestCommandDecision,
	type SuggestCommandRequest,
	setConfirmFn,
	setSuggestCommandFn,
};
