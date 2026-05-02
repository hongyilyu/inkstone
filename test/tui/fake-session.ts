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
		abort: number;
		setModel: Model<Api>[];
		setThinkingLevel: ThinkingLevel[];
		clearSession: number;
		selectAgent: string[];
		restoreMessages: AgentMessage[][];
		setSessionId: string[];
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
	} = {},
): FakeSessionHandle {
	let agentName = opts.agentName ?? "reader";
	let model = opts.model ?? FAKE_MODEL;
	let thinkingLevel: ThinkingLevel = opts.thinkingLevel ?? "off";
	let messageCount = 0;

	const calls: FakeSessionHandle["calls"] = {
		prompt: [],
		abort: 0,
		setModel: [],
		setThinkingLevel: [],
		clearSession: 0,
		selectAgent: [],
		restoreMessages: [],
		setSessionId: [],
	};

	let onEvent: (event: AgentEvent) => void = () => {};
	let createdSession: Session | null = null;
	const pendingFailures: Error[] = [];

	const factory: SessionFactory = (params) => {
		onEvent = params.onEvent;

		const session: Session = {
			actions: {
				async prompt(text: string) {
					calls.prompt.push(text);
					const fail = pendingFailures.shift();
					if (fail) throw fail;
				},
				abort() {
					calls.abort += 1;
				},
				setModel(m: Model<Api>) {
					model = m;
					calls.setModel.push(m);
				},
				setThinkingLevel(level: ThinkingLevel) {
					thinkingLevel = level;
					calls.setThinkingLevel.push(level);
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
				messageCount = 0;
			},
			restoreMessages(msgs: AgentMessage[]) {
				calls.restoreMessages.push(msgs);
				messageCount = msgs.length;
			},
			selectAgent(name: string) {
				// Track *and* reflect — the real Session mutates its bound
				// agent; the TUI wrapper reads `agentSession.agentName`
				// back into `store.currentAgent` immediately after calling
				// `selectAgent`, so the fake must update too.
				calls.selectAgent.push(name);
				agentName = name;
			},
		};
		createdSession = session;
		return session;
	};

	return {
		factory,
		emit: (event) => onEvent(event),
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
