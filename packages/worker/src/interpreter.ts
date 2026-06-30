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
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { manifestCodec } from "./manifest-codec.js";
import { makeProxyTools } from "./tool-proxy.js";
import { WorkerTransport } from "./transport.js";
import { logWorkerFault } from "./worker-log.js";

// Generic Workflow-agnostic interpreter — see docs/design/worker.md (ADR-0018, ADR-0019)

/** Dependency-injected hooks the interpreter needs (model resolution + LLM call). */
export interface InterpreterDeps {
	/** Resolve the provider model for this manifest's workflow. */
	resolveModel: (workflow: WorkerManifest["workflow"]) => Model<string>;
	/** The LLM call. Production injects the access token here; tests pass plain streamSimple. */
	streamFn: StreamFn;
}

/** Production deps: real model registry + token-injecting streamSimple (ADR-0023).
 *
 * pi-ai 0.80.2 retired the top-level `getModel`/`streamSimple` (they survive only
 * in the `@earendil-works/pi-ai/compat` shim, marked `@deprecated`). The modern
 * equivalent is a `Models` collection of the built-in providers: `.getModel`
 * resolves the catalog model, `.streamSimple` dispatches the request to the
 * provider that owns it. We build ONE collection and share it across both deps so
 * `streamSimple` resolves the same provider `resolveModel` looked the model up in.
 *
 * The OAuth access token still rides in `options.apiKey` (StreamOptions.apiKey,
 * unchanged): the collection's auth resolution leaves an injected `apiKey`
 * untouched for the oauth-only openai-codex provider, so the token reaches the
 * request headers exactly as before. */
export const defaultInterpreterDeps = (): InterpreterDeps => {
	const models = builtinModels();
	return {
		resolveModel: (workflow) =>
			models.getModel(workflow.provider, workflow.model) as Model<string>,
		streamFn: (model, context, options) =>
			// access_token is injected per-call by the manifest closure in runInterpreter.
			models.streamSimple(model, context, options),
	};
};

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
			messages: manifestCodec.toAgentMessages(manifest),
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
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "thinking_delta"
			) {
				// Reasoning/thinking deltas (ADR-0045 reasoning amendment, #202) stream as a
				// distinct Run Event so the Client renders them as a collapsed reasoning
				// segment, never folded into reply text.
				//
				// Redacted reasoning is already excluded by ARCHITECTURE, not by this guard:
				// pi surfaces Anthropic's redacted_thinking as a `thinking_start` carrying the
				// "[Reasoning redacted]" placeholder with NO following `thinking_delta` (the
				// block has nothing to stream), and we listen only for `thinking_delta`. The
				// literal-string check is a cheap best-effort backstop for a hypothetical
				// future provider that streams the placeholder as a delta — not the redaction
				// boundary itself.
				const delta = event.assistantMessageEvent.delta;
				if (delta.trim() !== "[Reasoning redacted]") {
					emit({ kind: "reasoning_delta", delta });
				}
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
			// A model/provider-reported run failure: worker-main's catchAll never sees
			// this (it's a successful Effect that emits a terminal error Run Event), so
			// log it here. Only the error branch — the done path is not a fault and is
			// left unlogged. Shares the `worker.run_error` key with worker-main's
			// catchAll so an agent's `GROUP BY event` mines every run error together;
			// `source` distinguishes this model-reported failure from the catchAll.
			logWorkerFault("worker.run_error", manifest.run_id, {
				source: "interpreter",
				message: errorMessage,
			});
			emit({ kind: "error", message: errorMessage });
			return;
		}
		emit({ kind: "done" });
	});
}
