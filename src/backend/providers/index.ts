import type { Api, Model } from "@mariozechner/pi-ai";
import { kiroProvider } from "./kiro";
import { openaiCodexProvider } from "./openai-codex";
import { openrouterProvider } from "./openrouter";
import type { ProviderInfo } from "./types";

/**
 * Static provider registry.
 *
 * Same design rationale as `backend/agent/agents.ts`: the registry never
 * changes at runtime, so frontends can import it directly rather than going
 * through the bridge. Only the *selected* provider id crosses the bridge as
 * reactive state (via `AgentStoreState.modelProvider`).
 */
export const PROVIDERS: ProviderInfo[] = [
	kiroProvider,
	openaiCodexProvider,
	openrouterProvider,
];

export function listProviders(): ProviderInfo[] {
	return PROVIDERS;
}

/**
 * Look up a provider by id. Returns `undefined` when the id doesn't match
 * any registered provider — callers that need a guaranteed provider must
 * handle `undefined` explicitly (e.g. boot-time resolution in
 * `backend/agent/index.ts` throws with a Connect nudge).
 *
 * Previously returned a DEFAULT_PROVIDER fallback; that concept is gone
 * along with Amazon Bedrock — every shipped provider requires explicit
 * user credentials, so there's no sensible "default" for a fresh install.
 */
export function getProvider(id: string): ProviderInfo | undefined {
	return PROVIDERS.find((p) => p.id === id);
}

/**
 * Find the first connected provider, optionally excluding one by id. Used
 * by the disconnect rehome chain: when the user disconnects the active
 * provider, the dialog picks the next connected provider (if any) so the
 * next prompt doesn't hit a 401 / no-provider error.
 *
 * Iteration order matches `PROVIDERS` declaration order, which mirrors
 * the Connect dialog's visual ordering. Returns `undefined` when zero
 * other connected providers exist — callers surface a warning toast
 * nudging the user to `/models`.
 */
export function findFirstConnectedProvider(
	excluding?: string,
): ProviderInfo | undefined {
	return PROVIDERS.find((p) => p.id !== excluding && p.isConnected());
}

/**
 * Find a specific model within a provider. Returns `undefined` when
 * either the providerId doesn't match any registered provider or the
 * modelId doesn't match any of the provider's listed models. Every
 * caller today treats `undefined` as terminal (boot-time resolution
 * falls through to the next chain step or throws).
 *
 * This is a convenience over pi-ai's `getModel(provider, id)` helper
 * because Inkstone's provider registry may include custom providers not
 * in pi-ai's static `MODELS` map.
 */
export function resolveModel(
	providerId: string,
	modelId: string,
): Model<Api> | undefined {
	const provider = getProvider(providerId);
	if (!provider) return undefined;
	const models = provider.listModels();
	return models.find((m) => m.id === modelId);
}

export type { ProviderInfo } from "./types";
