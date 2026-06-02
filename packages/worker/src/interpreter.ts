import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import type { Message, Model } from "@earendil-works/pi-ai";

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
 * Map the manifest's assembled history + current prompt into pi `Message[]`.
 * History is oldest-first and excludes the current turn; the current prompt
 * is appended as the final user message.
 */
function toAgentMessages(manifest: WorkerManifest): AgentMessage[] {
	const now = Date.now();
	const history: Message[] = manifest.messages.map((m): Message => {
		if (m.role === "user") {
			return { role: "user", content: m.text, timestamp: now };
		}
		return {
			role: "assistant",
			content: [{ type: "text", text: m.text }],
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
	});
	return history as AgentMessage[];
}

/**
 * Drive one Run to completion. Emits `text_delta` Run Events as the model
 * streams, then exactly one terminal event: `done` on clean completion or
 * `error` if the model/stream failed (pi surfaces this as an assistant
 * message with `stopReason: "error" | "aborted"`).
 *
 * The loop runs with `tools: []` — chat-only this slice (ADR-0018 tools are
 * a later slice).
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

	await runAgentLoop(
		[prompt],
		{
			systemPrompt: manifest.workflow.system_prompt,
			messages: toAgentMessages(manifest),
			tools: [],
		},
		{
			model,
			...(reasoning !== undefined ? { reasoning } : {}),
			convertToLlm: (messages) =>
				messages.filter(
					(m): m is Message =>
						m.role === "user" ||
						m.role === "assistant" ||
						m.role === "toolResult",
				),
		},
		(event) => {
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
					errorMessage =
						msg.errorMessage ?? `run ${msg.stopReason}`;
				}
			}
		},
		signal,
		streamFn,
	);

	if (errorMessage !== undefined) {
		emit({ kind: "error", message: errorMessage });
		return;
	}
	emit({ kind: "done" });
}
