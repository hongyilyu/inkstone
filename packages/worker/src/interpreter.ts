import type {
	AgentEventSink,
	AgentMessage,
	StreamFn,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	runAgentLoop,
	runAgentLoopContinue,
} from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { makeProxyTools } from "./tool-proxy.js";
import { WorkerTransport } from "./transport.js";

// Generic Workflow-agnostic interpreter — see docs/design/worker.md (ADR-0018, ADR-0019)

/** Dependency-injected hooks the interpreter needs (model resolution + LLM call). */
export interface InterpreterDeps {
	/** Resolve the provider model for this manifest's workflow. */
	resolveModel: (workflow: WorkerManifest["workflow"]) => Model<string>;
	/** The LLM call. Production injects the access token here; tests pass plain streamSimple. */
	streamFn: StreamFn;
}

/** Production deps: real model registry + token-injecting streamSimple (ADR-0023). */
export const defaultInterpreterDeps = (): InterpreterDeps => ({
	resolveModel: (workflow) =>
		getModel(
			workflow.provider as Parameters<typeof getModel>[0],
			workflow.model as never,
		) as Model<string>,
	streamFn: (model, context, options) => {
		// access_token is injected per-call by the manifest closure in runInterpreter.
		return streamSimple(model, context, options);
	},
});

/** Map the manifest's assembled history into pi `Message[]` — see docs/design/worker.md (ADR-0025). */
function toAgentMessages(manifest: WorkerManifest): AgentMessage[] {
	const now = Date.now();
	const history: Message[] = manifest.messages.map((m): Message => {
		if (m.role === "user") {
			return { role: "user", content: m.text, timestamp: now };
		}
		if (m.role === "tool_result") {
			return {
				role: "toolResult",
				toolCallId: m.tool_call_id,
				toolName: "",
				content: [{ type: "text", text: m.content }],
				isError: m.is_error ?? false,
				timestamp: now,
			};
		}
		const assistant: Message & { role: "assistant" } = {
			role: "assistant",
			content: [],
			api: "",
			provider: "",
			model: manifest.workflow.model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		};
		if (m.text !== undefined) {
			assistant.content.push({ type: "text", text: m.text });
		}
		for (const tc of m.tool_calls ?? []) {
			assistant.content.push({
				type: "toolCall",
				id: tc.id,
				name: tc.name,
				arguments: (tc.arguments ?? {}) as Record<string, unknown>,
			});
		}
		return assistant;
	});
	return history as AgentMessage[];
}

/** Drive one Run to completion, emitting `text_delta` events then one terminal `done`/`error` — see docs/design/worker.md (ADR-0018, ADR-0025). */
export function runInterpreter(
	manifest: WorkerManifest,
	deps: InterpreterDeps,
	signal?: AbortSignal,
): Effect.Effect<void, never, WorkerTransport> {
	return Effect.gen(function* () {
		// Both channels feed pi's callbacks, which run outside the Effect context (ADR-0027).
		const { emit, callTool } = yield* WorkerTransport;

		const model = deps.resolveModel(manifest.workflow);
		const prompt: AgentMessage = {
			role: "user",
			content: manifest.prompt,
			timestamp: Date.now(),
		};

		const tools =
			manifest.workflow.tools.length > 0
				? makeProxyTools(manifest.workflow.tools, callTool)
				: [];

		// Inject the OAuth access token (if present) as the provider apiKey (ADR-0023).
		const streamFn: StreamFn = (model_, context, options) =>
			deps.streamFn(model_, context, {
				...options,
				...(manifest.access_token !== undefined
					? { apiKey: manifest.access_token }
					: {}),
			});

		let errorMessage: string | undefined;

		// pi takes `reasoning` (SimpleStreamOptions): "off" → omit; any other level maps through.
		const reasoning =
			manifest.workflow.thinking_level === "off"
				? undefined
				: (manifest.workflow.thinking_level as Exclude<ThinkingLevel, "off">);

		const context = {
			systemPrompt: manifest.workflow.system_prompt,
			messages: toAgentMessages(manifest),
			tools,
		};
		const config = {
			model,
			...(reasoning !== undefined ? { reasoning } : {}),
			convertToLlm: (messages: AgentMessage[]) =>
				messages.filter(
					(m): m is Message =>
						m.role === "user" ||
						m.role === "assistant" ||
						m.role === "toolResult",
				),
		};
		const onEvent: AgentEventSink = (event) => {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				emit({ kind: "text_delta", delta: event.assistantMessageEvent.delta });
				return;
			}
			if (event.type === "message_end") {
				const msg = event.message;
				if (
					msg.role === "assistant" &&
					(msg.stopReason === "error" || msg.stopReason === "aborted")
				) {
					errorMessage = msg.errorMessage ?? `run ${msg.stopReason}`;
				}
			}
		};

		if (manifest.mode === "resume") {
			// Resume (ADR-0025): transcript is already the context; continue without a new prompt.
			yield* Effect.promise(() =>
				runAgentLoopContinue(context, config, onEvent, signal, streamFn),
			);
		} else {
			yield* Effect.promise(() =>
				runAgentLoop([prompt], context, config, onEvent, signal, streamFn),
			);
		}

		if (errorMessage !== undefined) {
			emit({ kind: "error", message: errorMessage });
			return;
		}
		emit({ kind: "done" });
	});
}
