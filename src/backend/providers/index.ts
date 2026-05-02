import type { Api, Model } from "@mariozechner/pi-ai";
import { bedrockProvider } from "./amazon-bedrock";
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
	bedrockProvider,
	kiroProvider,
	openaiCodexProvider,
	openrouterProvider,
];

// Invariant: the registry is non-empty by construction, so `PROVIDERS[0]`
// always exists. Non-null assertion keeps the return type narrow under
// `noUncheckedIndexedAccess`.
// biome-ignore lint/style/noNonNullAssertion: registry is non-empty by construction
const DEFAULT_INFO = PROVIDERS[0]!;
export const DEFAULT_PROVIDER = DEFAULT_INFO.id;

export function listProviders(): ProviderInfo[] {
	return PROVIDERS;
}

export function getProvider(id: string | undefined | null): ProviderInfo {
	return PROVIDERS.find((p) => p.id === id) ?? DEFAULT_INFO;
}

/**
 * Find a specific model within a provider. Returns the first model in the
 * provider's list when `modelId` doesn't match — the caller can compare
 * `returned.id === modelId` to detect a miss without a second lookup.
 *
 * This is a convenience over the pi-ai `getModel(provider, id)` helper
 * because Inkstone's provider registry may include custom providers not in
 * pi-ai's static `MODELS` map.
 */
export function resolveModel(
	providerId: string,
	modelId: string,
): Model<Api> | undefined {
	const provider = getProvider(providerId);
	const models = provider.listModels();
	return models.find((m) => m.id === modelId);
}

export type { ProviderInfo } from "./types";
