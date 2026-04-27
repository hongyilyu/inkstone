import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export const bedrockProvider: ProviderInfo = {
	id: "amazon-bedrock",
	displayName: "Amazon Bedrock",
	// Explicit curated default — do not fall back to `listModels()[0]`,
	// which is pi-ai-registry-order-dependent.
	defaultModelId: "us.anthropic.claude-opus-4-7",
	listModels: () => getModels("amazon-bedrock"),
	getApiKey: () => undefined,
	isConnected: () =>
		getEnvApiKey("amazon-bedrock") !== undefined || hasAwsSharedConfig(),
	authInstructions:
		"Run `aws configure` or `aws sso login`, or set AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY / AWS_BEARER_TOKEN_BEDROCK in your environment.",
};
