import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { getEnvApiKey, getModels } from "@mariozechner/pi-ai";
import type { ProviderInfo } from "./types";

/**
 * Amazon Bedrock provider. Auth detection + `getApiKey` semantics are
 * documented in `docs/ARCHITECTURE.md` § Provider registry. `hasAwsSharedConfig`
 * covers the standard `aws configure` / `aws sso login` desktop flow.
 */
function hasAwsSharedConfig(): boolean {
	const credentialsPath =
		process.env.AWS_SHARED_CREDENTIALS_FILE ??
		join(homedir(), ".aws", "credentials");
	const configPath =
		process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
	return existsSync(credentialsPath) || existsSync(configPath);
}

/**
 * Hide Bedrock Anthropic IDs that can't be invoked on-demand. Raw
 * `anthropic.*` IDs require an inference profile (e.g. created via the
 * Bedrock console or `aws bedrock create-inference-profile`) — selecting
 * one in `DialogModel` fails at first stream with a
 * `ValidationException: Invocation of model ID ... with on-demand
 * throughput isn't supported`.
 *
 * The regional-prefix variants (`us.`, `eu.`, `apac.`, `global.`) ARE
 * on-demand-capable and stay listed. Non-Anthropic vendors on Bedrock
 * (`amazon.nova-*`, `meta.llama*`, etc.) use different invocation
 * patterns and pass through unchanged.
 *
 * The curated `defaultModelId` is covered by a regression test in
 * `test/bedrock-filter.test.ts` — a future pi-ai rename that drops it
 * surfaces there before the agent module's own "default no longer
 * resolves" boot throw.
 *
 * When pi-ai adds a per-model on-demand flag, replace the prefix check
 * with an explicit positive match (e.g. `m.onDemand === true`) so
 * `undefined` doesn't silently widen what `DialogModel` offers. Exact
 * shape depends on what pi-ai ships. Tracked in TODO § Future Work.
 */
function isOnDemandBedrockModel(model: Model<Api>): boolean {
	return !model.id.startsWith("anthropic.");
}

export const bedrockProvider: ProviderInfo = {
	id: "amazon-bedrock",
	displayName: "Amazon Bedrock",
	// Explicit curated default — do not fall back to `listModels()[0]`,
	// which is pi-ai-registry-order-dependent.
	defaultModelId: "us.anthropic.claude-opus-4-7",
	listModels: () => getModels("amazon-bedrock").filter(isOnDemandBedrockModel),
	getApiKey: () => undefined,
	isConnected: () =>
		getEnvApiKey("amazon-bedrock") !== undefined || hasAwsSharedConfig(),
	authInstructions:
		"Run `aws configure` or `aws sso login`, or set AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY / AWS_BEARER_TOKEN_BEDROCK in your environment.",
};

// Internal helper export for tests. Not part of the public provider API.
export { isOnDemandBedrockModel };
