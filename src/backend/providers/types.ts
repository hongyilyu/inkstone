import type { Api, Model } from "@mariozechner/pi-ai";

/**
 * Inkstone's provider abstraction. A `ProviderInfo` wraps one logical
 * model-hosting service (Amazon Kiro, ChatGPT, OpenRouter, …) with the
 * user-facing metadata Inkstone needs on top of pi-ai's per-API stream
 * registry. See `docs/ARCHITECTURE.md` § Provider registry for why the
 * registry sits above pi-ai, how custom `baseUrl` providers slot in,
 * and which extension points are intentionally deferred.
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

	/**
	 * Cheap, provider-local model used for background session title
	 * generation. Optional only for third-party/custom providers that do
	 * not yet choose one; title resolution falls back to the active chat
	 * model when absent or unavailable.
	 */
	titleModelId?: string;

	/** All models this provider exposes. May be static (pi-ai registry) or
	 * dynamically constructed (custom endpoints). */
	listModels(): Model<Api>[];

	/** Value forwarded to pi-agent-core's Agent `getApiKey` hook when this
	 * provider is active. Returning `undefined` is valid for providers
	 * whose SDK reads credentials from the environment directly (none
	 * today, but the escape hatch stays open for future env-var providers).
	 *
	 * May return a Promise — pi-agent-core's hook awaits it (`agent-loop.js:156`).
	 * OAuth providers use this to refresh expired access tokens lazily on the
	 * next stream instead of running a background scheduler. */
	getApiKey(): string | undefined | Promise<string | undefined>;

	/** True when credentials are configured and the provider can be used. */
	isConnected(): boolean;

	/**
	 * Remove persisted credentials for this provider. Synchronous —
	 * handles only credential removal, not UI or rehome. Intended to be
	 * called from the UI layer's disconnect flow; do not clear creds
	 * speculatively from other backend code. Errors should be routed
	 * through `reportPersistenceError` internally where the underlying
	 * storage layer has a convention (e.g. atomic-write path in
	 * `persistence/auth.ts`); synchronous throws are caught defensively
	 * by the UI caller.
	 */
	clearCreds(): void;
}
