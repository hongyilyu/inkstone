import type { Api, Model } from "@mariozechner/pi-ai";

/**
 * Inkstone's provider abstraction.
 *
 * A `ProviderInfo` wraps one logical model-hosting service (e.g. Amazon
 * Bedrock, Amazon Kiro, Anthropic direct). It exists on top of pi-ai's
 * per-API stream-function registry so that:
 *
 *   1. Inkstone has a single place that owns user-facing metadata
 *      (displayName, connection check, auth instructions) per provider.
 *   2. Custom providers that pi-ai doesn't ship (but that are wire-compatible
 *      with an existing pi-ai API — e.g. Bedrock-Converse-compatible endpoints
 *      like Amazon Kiro) can plug in by building their own `Model<Api>`
 *      objects with a custom `baseUrl`, without modifying pi-ai itself.
 *
 * Fundamentally-different custom providers that need their own streaming
 * transport would additionally require threading a custom `streamFn` into
 * pi-agent-core. That extension is not present here — add it the day we
 * actually need it, not speculatively.
 */
export interface ProviderInfo {
	/** Stable provider id. Must match the `Model.provider` field of models
	 * returned by `listModels()`. */
	id: string;

	/** Human-readable name shown in dialogs and per-message footers. */
	displayName: string;

	/**
	 * Model id used when the on-disk `modelId` is absent (fresh install) or
	 * no longer resolvable through `listModels()` (e.g. pi-ai dropped it in
	 * an upgrade). Must match an id returned by `listModels()` at the time
	 * it is selected — the agent module throws on boot if it doesn't, so
	 * registry drift surfaces loudly instead of silently falling through to
	 * an arbitrary model.
	 *
	 * Required (not optional) so every provider has to declare its own
	 * curated default. Do not let the fallback depend on list ordering.
	 */
	defaultModelId: string;

	/** All models this provider exposes. May be static (pi-ai registry) or
	 * dynamically constructed (custom endpoints). */
	listModels(): Model<Api>[];

	/** Value forwarded to pi-agent-core's Agent `getApiKey` hook when this
	 * provider is active. Returning `undefined` is valid for providers whose
	 * SDK reads credentials from the environment directly (e.g. Bedrock).
	 *
	 * May return a Promise — pi-agent-core's hook awaits it (`agent-loop.js:156`).
	 * OAuth providers use this to refresh expired access tokens lazily on the
	 * next stream instead of running a background scheduler. */
	getApiKey(): string | undefined | Promise<string | undefined>;

	/** True when credentials are configured and the provider can be used. */
	isConnected(): boolean;

	/** Human-readable authentication instructions, shown when the user picks
	 * a disconnected provider in the Connect dialog. */
	authInstructions: string;
}
