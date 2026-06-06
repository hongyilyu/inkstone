import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import {
	runAgentLoop,
	runAgentLoopContinue,
} from "@earendil-works/pi-agent-core";
import type {
	AgentEventSink,
	AgentMessage,
	StreamFn,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import type { Message, Model } from "@earendil-works/pi-ai";
import { type CallTool, makeProxyTools } from "./tool-proxy.js";
export type { CallTool, ToolCallResponse } from "./tool-proxy.js";

/**
 * The generic interpreter (ADR-0018): a single, Workflow-agnostic loop that
 * turns a {@link WorkerManifest} into a streamed conversation against a real
 * provider via `pi-agent-core`. There is NO per-Workflow code here — the
 * manifest is pure data.
 *
 * This module is provider-agnostic and dependency-injected so it can be
 * driven offline by `pi-ai`'s `faux` provider in tests (ADR-0019 as-built):
 * the caller supplies how to resolve a `Model` from the manifest and the
 * `streamFn` that issues the LLM call. Production wiring (real `getModel` +
 * token-injecting `streamSimple`) lives in {@link defaultInterpreterDeps};
 * tests pass a faux model + plain `streamSimple`.
 */

export type Emit = (event: RunEvent) => void;

export interface InterpreterDeps {
	/** Resolve the provider model for this manifest's workflow. */
	resolveModel: (workflow: WorkerManifest["workflow"]) => Model<string>;
	/** The LLM call. Production injects the access token here; tests pass plain streamSimple. */
	streamFn: StreamFn;
	/**
	 * Round-trip a tool call to Core (ADR-0018). Required for a Workflow whose
	 * manifest carries tool descriptors; absent → the loop runs with no tools.
	 */
	callTool?: CallTool;
}

/** Production deps: real model registry + token-injecting streamSimple (ADR-0023). */
export const defaultInterpreterDeps = (): InterpreterDeps => ({
	resolveModel: (workflow) =>
		getModel(
			workflow.provider as Parameters<typeof getModel>[0],
			workflow.model as never,
		) as Model<string>,
	streamFn: (model, context, options) => {
		// access_token is injected per-call by the manifest closure in
		// `runInterpreter`; here we just forward whatever options carry.
		return streamSimple(model, context, options);
	},
});

/**
 * Map the manifest's assembled history into pi `Message[]`. Handles the
 * tagged-union {@link WorkerManifest} message blocks (ADR-0025):
 * - `user` → a pi `UserMessage` carrying the text.
 * - `assistant` → a pi `AssistantMessage` whose `content` is the optional
 *   text block followed by any `tool_calls` as `toolCall` content blocks
 *   (so a resumed transcript carries the prior turn's tool requests).
 * - `tool_result` → a pi `ToolResultMessage` whose `toolCallId` matches the
 *   assistant's `toolCall.id` — the pairing that makes the transcript
 *   provider-valid (a `toolResult` is rejected unless its `toolCall`
 *   precedes it).
 *
 * History is oldest-first and, for the fresh path, excludes the current turn
 * (the prompt is appended separately). For the resume path the manifest's
 * `messages` IS the full transcript (ending in a `tool_result`).
 */
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
		// assistant: optional text block, then any tool_call blocks.
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

/**
 * Drive one Run to completion. Emits `text_delta` Run Events as the model
 * streams, then exactly one terminal event: `done` on clean completion or
 * `error` if the model/stream failed (pi surfaces this as an assistant
 * message with `stopReason: "error" | "aborted"`).
 *
 * Tools (ADR-0018): the Workflow's tool descriptors become `pi-agent-core`
 * proxies whose `execute` round-trips to Core via `deps.callTool`. A manifest
 * with no tools (or no `callTool`) runs chat-only.
 *
 * Mode (ADR-0025): `manifest.mode === "resume"` continues a reconstructed
 * transcript via `runAgentLoopContinue` — the manifest's `messages` ARE the
 * full transcript (ending in a `tool_result`) and NO new prompt is added, so
 * the seeded tool call is not re-executed. Any other/absent mode is the fresh
 * path: `runAgentLoop([prompt], …)` as before.
 */
export async function runInterpreter(
	manifest: WorkerManifest,
	emit: Emit,
	deps: InterpreterDeps,
	signal?: AbortSignal,
): Promise<void> {
	const model = deps.resolveModel(manifest.workflow);
	const prompt: AgentMessage = {
		role: "user",
		content: manifest.prompt,
		timestamp: Date.now(),
	};

	const tools =
		manifest.workflow.tools.length > 0 && deps.callTool !== undefined
			? makeProxyTools(manifest.workflow.tools, deps.callTool)
			: [];

	// Inject the OAuth access token (if present) as the provider apiKey for
	// every call this Run makes (ADR-0023). faux/env providers omit it.
	const streamFn: StreamFn = (model_, context, options) =>
		deps.streamFn(model_, context, {
			...options,
			...(manifest.access_token !== undefined
				? { apiKey: manifest.access_token }
				: {}),
		});

	let errorMessage: string | undefined;

	// pi's functional loop takes `reasoning` (SimpleStreamOptions), not the
	// stateful Agent's `thinkingLevel`. "off" means no reasoning → omit it;
	// any other level maps straight through (pi-ai ThinkingLevel excludes
	// "off").
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
		// Resume (ADR-0025): the manifest's transcript is already the context
		// (last message is a `tool_result`); continue without a new prompt.
		await runAgentLoopContinue(context, config, onEvent, signal, streamFn);
	} else {
		await runAgentLoop([prompt], context, config, onEvent, signal, streamFn);
	}

	if (errorMessage !== undefined) {
		emit({ kind: "error", message: errorMessage });
		return;
	}
	emit({ kind: "done" });
}
