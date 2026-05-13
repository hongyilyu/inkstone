/**
 * In-memory `Session` fake for TUI tests.
 *
 * The real `createSession` in `@backend/agent` builds a pi-agent-core
 * `Agent`, resolves providers, talks to an LLM. Tests inject this
 * factory via `<AgentProvider session={makeFakeSession()}>` so the
 * reducer runs against scripted `AgentEvent`s without any network
 * or provider dependency.
 *
 * Usage:
 *
 *   const fake = makeFakeSession();
 *   // inside the test:
 *   await renderApp({ session: fake.factory });
 *   fake.emit({ type: "agent_start" });
 *   fake.emit({ type: "message_start", message: {...} });
 *   ...
 *   expect(fake.calls.prompt).toEqual([["hello"]]);
 */

import type {
	AgentEvent,
	AgentMessage,
	ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Model,
} from "@mariozechner/pi-ai";
import { DEFAULT_AGENT_NAME } from "../../src/backend/agent";
import type { SessionSnapshot } from "../../src/bridge/view-model";
import type { Session, SessionFactory } from "../../src/tui/context/agent";

/**
 * Minimal Model<Api> stub. The reducer only reads a few fields.
 *
 * Points at OpenRouter's `anthropic/claude-opus-4.7` entry — a real id
 * in pi-ai 0.72.1's generated registry. Matches `test/preload.ts`'s
 * OpenRouter key seed so `isConnected()` reports true and `getProvider`
 * / `resolveModel` round-trip correctly in any reducer test that
 * exercises provider display names or model lookup.
 */
export const FAKE_MODEL: Model<Api> = {
	id: "anthropic/claude-opus-4.7",
	name: "Anthropic: Claude Opus 4.7",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
} as Model<Api>;

/** Bookkeeping returned by `makeFakeSession`. */
export interface FakeSessionHandle {
	/** The factory to pass as `<AgentProvider session={...}>`. */
	factory: SessionFactory;
	/** Push a synthetic `AgentEvent` through the reducer. */
	emit: (event: AgentEvent) => void;
	/** Recorded actions.* calls. */
	calls: {
		prompt: string[];
		continue: number;
		abort: number;
		setModel: Model<Api>[];
		setThinkingLevel: ThinkingLevel[];
		clearAgentModel: number;
		clearAgentThinkingLevel: number;
		clearSession: number;
		selectAgent: string[];
		restoreMessages: AgentMessage[][];
		setSessionId: string[];
		dispose: number;
	};
	/**
	 * Force the next N `actions.prompt()` calls to reject with the given
	 * error instead of resolving. Used to exercise the reducer's
	 * pre-stream-error recovery path (agent.tsx's try/catch around
	 * `await agentSession.actions.prompt(text)`). Each call pops one
	 * scheduled rejection; unset → normal resolve.
	 */
	failNextPrompt: (err: Error) => void;
	/**
	 * The `onEvent` handler `AgentProvider` registered. Most tests call
	 * `emit` directly; exposed for escape hatches.
	 */
	getHandler: () => (event: AgentEvent) => void;
	/**
	 * Escape hatch for reducer-invariant tests that need to simulate
	 * a mid-stream state change (e.g. a model switch that flips the
	 * fake's backing thinkingLevel). Returns the live Session so tests
	 * can call `setThinkingLevel` / `setModel` etc. directly — same
	 * handle the provider uses.
	 */
	getSession: () => Session;
}

export function makeFakeSession(
	opts: {
		agentName?: string;
		model?: Model<Api>;
		thinkingLevel?: ThinkingLevel;
		/**
		 * Optional per-agent model map. Mirrors the real backend's
		 * `selectAgent` behavior: switching the bound agent also flips
		 * the resolved (provider, model) pair to that agent's
		 * per-agent override (or the top-level default when an agent
		 * has no entry). Tests that exercise the per-agent model
		 * isolation invariant pass a map keyed by agent name.
		 */
		agentModels?: Record<string, Model<Api>>;
		/** Per-agent thinking level. Same semantics as `agentModels`. */
		agentThinkingLevels?: Record<string, ThinkingLevel>;
	} = {},
): FakeSessionHandle {
	let agentName = opts.agentName ?? "reader";
	let model = opts.agentModels?.[agentName] ?? opts.model ?? FAKE_MODEL;
	let thinkingLevel: ThinkingLevel =
		opts.agentThinkingLevels?.[agentName] ?? opts.thinkingLevel ?? "off";
	let messageCount = 0;
	// Mirror pi-agent-core's `activeRun` lifecycle. Set to `true` on
	// `agent_start`; stays `true` through `agent_end` event delivery
	// (matching pi-agent-core's `processEvents` shape — the run isn't
	// "finished" until AFTER all `agent_end` listeners resolve). The
	// reducer's `agent_end` handler runs synchronously inside our
	// `emit(...)` call and reads this as still-active; the fake clears
	// it after `emit(agent_end)` returns. Listeners that read
	// `clearSession` during `agent_end` see the still-active branch
	// (matching the real backend's `agent.signal` truthy state at the
	// same point) — which is what surfaces the routing-seam timing bug.
	let activeRun = false;

	const calls: FakeSessionHandle["calls"] = {
		prompt: [],
		continue: 0,
		abort: 0,
		setModel: [],
		setThinkingLevel: [],
		clearAgentModel: 0,
		clearAgentThinkingLevel: 0,
		clearSession: 0,
		selectAgent: [],
		restoreMessages: [],
		setSessionId: [],
		dispose: 0,
	};

	let onEvent: (event: AgentEvent) => void = () => {};
	let createdSession: Session | null = null;
	const pendingFailures: Error[] = [];
	const subscribers = new Set<(snap: SessionSnapshot) => void>();
	function buildSnapshot(): SessionSnapshot {
		return {
			agentName,
			modelName: model.name,
			modelProvider: model.provider,
			contextWindow: model.contextWindow,
			modelReasoning: model.reasoning,
			thinkingLevel,
		};
	}
	function notify(): void {
		const snap = buildSnapshot();
		for (const cb of subscribers) cb(snap);
	}
	/**
	 * Mirror the real backend's `clearSession` rebind-to-default tail.
	 * `clearSession` ends an in-memory lifetime and starts a fresh one
	 * (ADR 0008); a fresh lifetime is bound to the router by
	 * definition (ADR 0007 / `resolveInitialAgentName`). Tracked
	 * separately from `calls.selectAgent` because it's not the user
	 * `selectAgent` verb — it's part of `clearSession`'s contract.
	 */
	function rebindToDefault(): void {
		if (agentName === DEFAULT_AGENT_NAME) return;
		agentName = DEFAULT_AGENT_NAME;
		if (opts.agentModels?.[DEFAULT_AGENT_NAME]) {
			model = opts.agentModels[DEFAULT_AGENT_NAME];
		}
		if (opts.agentThinkingLevels?.[DEFAULT_AGENT_NAME]) {
			thinkingLevel = opts.agentThinkingLevels[DEFAULT_AGENT_NAME];
		}
		notify();
	}

	const factory: SessionFactory = (params) => {
		onEvent = params.onEvent;

		const session: Session = {
			actions: {
				async prompt(text: string) {
					calls.prompt.push(text);
					// Mirror the real backend: `agent.prompt(text)` pushes
					// a user message onto `_state.messages` before the
					// stream loop starts. Without this, `selectAgent`'s
					// empty-session invariant in the fake never sees a
					// populated state and silently passes when it
					// shouldn't.
					messageCount += 1;
					const fail = pendingFailures.shift();
					if (fail) throw fail;
				},
				async continue() {
					// Routing-fork seam: fires after `restoreMessages`
					// has seeded the user message; pi-agent-core's
					// `continue()` runs the loop from that tail. The
					// fake just records the call so tests can assert
					// the seam fired the child agent's turn.
					calls.continue += 1;
				},
				abort() {
					calls.abort += 1;
				},
				setModel(m: Model<Api>) {
					model = m;
					calls.setModel.push(m);
					notify();
				},
				setThinkingLevel(level: ThinkingLevel) {
					thinkingLevel = level;
					calls.setThinkingLevel.push(level);
					notify();
				},
				clearAgentModel() {
					// Mirror the real backend: drop the override + revert
					// to whatever the test seeded as the "top-level"
					// model (the fake's `model` opt). Tests asserting
					// the clear-row UX pass `model` and `agentModels`
					// separately so this can show the difference.
					calls.clearAgentModel += 1;
					model = opts.model ?? FAKE_MODEL;
					notify();
				},
				clearAgentThinkingLevel() {
					calls.clearAgentThinkingLevel += 1;
					thinkingLevel = opts.thinkingLevel ?? "off";
					notify();
				},
			},
			get agentName() {
				return agentName;
			},
			get messageCount() {
				return messageCount;
			},
			getModel: () => model,
			getProviderId: () => model.provider,
			getModelId: () => model.id,
			getThinkingLevel: () => thinkingLevel,
			setSessionId(id: string) {
				calls.setSessionId.push(id);
			},
			async clearSession() {
				calls.clearSession += 1;
				// Mirror the real backend's two-branch shape: when the run
				// is active, abort + waitForIdle, then reset. When idle,
				// reset synchronously. The bug we're guarding against is:
				// `void clearSession()` (sync caller, can't await) drops
				// the await, leaving `messageCount > 0` when `selectAgent`
				// runs next. Without the active-run branch, the fake would
				// always reset synchronously and the bug stays hidden.
				if (activeRun) {
					// Schedule the reset on a microtask. The sync caller
					// (resumeSessionAction inside batch()) does NOT await.
					// `messageCount` stays > 0 across the synchronous
					// `selectAgent` call, which throws the empty-session
					// error — exactly the failure mode reported from the
					// running app.
					await Promise.resolve();
					messageCount = 0;
					rebindToDefault();
					return;
				}
				messageCount = 0;
				rebindToDefault();
			},
			restoreMessages(msgs: AgentMessage[]) {
				calls.restoreMessages.push(msgs);
				messageCount = msgs.length;
			},
			selectAgent(name: string) {
				// Empty-session invariant matches the real backend
				// (`src/backend/agent/index.ts` `selectAgent`): swapping
				// the bound agent on a non-empty session is forbidden
				// (D13). Without this check the fake silently accepts
				// the swap and the routing-seam timing bug stays
				// hidden behind a green test.
				if (messageCount > 0) {
					throw new Error(
						"Agent is fixed for the lifetime of a session. " +
							"Clear the session before selecting a different agent.",
					);
				}
				// Track *and* reflect — the real Session mutates its bound
				// agent; the TUI wrapper reads `agentSession.agentName`
				// back into `store.currentAgent` immediately after calling
				// `selectAgent`, so the fake must update too. Also flip
				// model + thinking level when the test supplies a
				// per-agent map (matches real backend behavior introduced
				// alongside per-agent model overrides).
				calls.selectAgent.push(name);
				agentName = name;
				if (opts.agentModels?.[name]) {
					model = opts.agentModels[name];
				}
				if (opts.agentThinkingLevels?.[name]) {
					thinkingLevel = opts.agentThinkingLevels[name];
				}
				notify();
			},
			snapshot: buildSnapshot,
			subscribe(cb) {
				subscribers.add(cb);
				return () => {
					subscribers.delete(cb);
				};
			},
			dispose() {
				calls.dispose += 1;
			},
		};
		createdSession = session;
		return session;
	};

	return {
		factory,
		emit: (event) => {
			// Mirror pi-agent-core's `processEvents` shape: state
			// updates happen BEFORE listener delivery so listeners
			// (our reducer) see a populated `messages` count + a
			// truthy `activeRun` during `agent_end`. Crucially,
			// `activeRun` stays `true` across any microtasks that
			// the listener schedules (pi-agent-core's `finishRun()`
			// runs only AFTER all `agent_end` listeners' awaited
			// promises resolve, which means after their entire
			// microtask chain drains). We model this with
			// `queueMicrotask(activeRun = false)` AFTER the listener
			// returns: microtasks queued by the listener BEFORE this
			// one (e.g. a `queueMicrotask(resumeSession)`) run first
			// and observe `activeRun === true` — matching real
			// pi-agent-core timing and surfacing the seam bug. A
			// macrotask defer (e.g. `setTimeout(0)` in the seam) yields
			// past this clear and observes `activeRun === false`,
			// matching the real fix.
			switch (event.type) {
				case "agent_start":
					activeRun = true;
					break;
				case "message_end":
					// Pi-agent-core pushes the assistant message to
					// `_state.messages` BEFORE awaiting listeners.
					messageCount += 1;
					break;
				default:
					break;
			}
			onEvent(event);
			if (event.type === "agent_end") {
				queueMicrotask(() => {
					activeRun = false;
				});
			}
		},
		calls,
		failNextPrompt: (err) => pendingFailures.push(err),
		getHandler: () => onEvent,
		getSession: () => {
			if (!createdSession)
				throw new Error("fake session: factory has not been called yet");
			return createdSession;
		},
	};
}

// ---------------------------------------------------------------------------
// `AgentEvent` builders. Compose a full turn by chaining them through `emit`.
// ---------------------------------------------------------------------------

/**
 * Stable-shape assistant base so tests can fill in just what matters.
 *
 * Top-level fields override via spread. `usage` is deep-merged: a test
 * passing `{ usage: { totalTokens: 1234 } }` keeps the default zeros
 * for `input`/`output`/`cacheRead`/`cacheWrite`/`cost.*` so tests that
 * only care about the total don't need to spell out the full object.
 * `usage.cost` merges one level deeper for the same reason.
 */
export function assistantMessage(
	partial: Partial<AssistantMessage> = {},
): AssistantMessage {
	const baseUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const { usage: partialUsage, ...rest } = partial;
	const usage = partialUsage
		? {
				...baseUsage,
				...partialUsage,
				cost: { ...baseUsage.cost, ...(partialUsage.cost ?? {}) },
			}
		: baseUsage;
	return {
		role: "assistant",
		content: [],
		api: FAKE_MODEL.api,
		provider: FAKE_MODEL.provider,
		model: FAKE_MODEL.id,
		stopReason: "stop",
		timestamp: Date.now(),
		...rest,
		usage,
	};
}

export function ev_agentStart(): AgentEvent {
	return { type: "agent_start" };
}

export function ev_messageStart(): AgentEvent {
	return { type: "message_start", message: assistantMessage() };
}

export function ev_messageEnd(
	partial: Partial<AssistantMessage> = {},
): AgentEvent {
	return {
		type: "message_end",
		message: assistantMessage(partial),
	};
}

export function ev_agentEnd(messages: AgentMessage[] = []): AgentEvent {
	return { type: "agent_end", messages };
}

export function ev_textStart(): AgentEvent {
	return {
		type: "message_update",
		message: assistantMessage(),
		assistantMessageEvent: {
			type: "text_start",
			contentIndex: 0,
			partial: assistantMessage(),
		} as AssistantMessageEvent,
	};
}

export function ev_textDelta(delta: string): AgentEvent {
	return {
		type: "message_update",
		message: assistantMessage(),
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: assistantMessage(),
		} as AssistantMessageEvent,
	};
}

export function ev_thinkingStart(): AgentEvent {
	return {
		type: "message_update",
		message: assistantMessage(),
		assistantMessageEvent: {
			type: "thinking_start",
			contentIndex: 0,
			partial: assistantMessage(),
		} as AssistantMessageEvent,
	};
}

export function ev_thinkingDelta(delta: string): AgentEvent {
	return {
		type: "message_update",
		message: assistantMessage(),
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta,
			partial: assistantMessage(),
		} as AssistantMessageEvent,
	};
}

export function ev_thinkingEnd(content: string): AgentEvent {
	return {
		type: "message_update",
		message: assistantMessage(),
		assistantMessageEvent: {
			type: "thinking_end",
			contentIndex: 0,
			content,
			partial: assistantMessage(),
		} as AssistantMessageEvent,
	};
}

export function ev_toolcallEnd(
	callId: string,
	name: string,
	args: Record<string, unknown>,
): AgentEvent {
	return {
		type: "message_update",
		message: assistantMessage(),
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: {
				type: "toolCall",
				id: callId,
				name,
				arguments: args,
			},
			partial: assistantMessage(),
		} as AssistantMessageEvent,
	};
}

export function ev_toolExecStart(
	callId: string,
	name: string,
	args: Record<string, unknown>,
): AgentEvent {
	return {
		type: "tool_execution_start",
		toolCallId: callId,
		toolName: name,
		args,
	};
}

export function ev_toolExecEnd(
	callId: string,
	name: string,
	opts: { isError?: boolean; result?: any } = {},
): AgentEvent {
	return {
		type: "tool_execution_end",
		toolCallId: callId,
		toolName: name,
		result: opts.result ?? { content: [{ type: "text", text: "ok" }] },
		isError: opts.isError ?? false,
	};
}
