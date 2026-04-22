import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEnvApiKey, getModels } from "@mariozechner/pi-ai";
import type { ProviderInfo } from "./types";

/**
 * Amazon Bedrock provider.
 *
 * Auth detection combines two signals:
 *
 *   1. pi-ai's `getEnvApiKey("amazon-bedrock")` — covers AWS_PROFILE,
 *      AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, AWS_BEARER_TOKEN_BEDROCK,
 *      and ECS / IRSA container env vars.
 *   2. Presence of `~/.aws/credentials` or `~/.aws/config` (honoring
 *      AWS_SHARED_CREDENTIALS_FILE / AWS_CONFIG_FILE overrides) — covers
 *      the standard `aws configure` / `aws sso login` desktop flow, where
 *      the SDK's default credential provider chain resolves the `[default]`
 *      profile without requiring AWS_PROFILE to be exported.
 *
 * Still not detected: pure EC2 IMDS with no local credentials file or env
 * marker. That's rare for this tool's desktop/server use; users there can
 * set any AWS_* env var (e.g. AWS_PROFILE=default) to hint.
 *
 * `getApiKey()` returns `undefined` because pi-ai's Bedrock provider reads
 * AWS env vars directly via the AWS SDK chain. Forwarding anything through
 * pi-agent-core's `getApiKey` hook is unnecessary and would be dropped
 * silently.
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
	// which is pi-ai-registry-order-dependent (Nova 2 Lite today).
	defaultModelId: "us.anthropic.claude-opus-4-7",
	listModels: () => getModels("amazon-bedrock"),
	getApiKey: () => undefined,
	isConnected: () =>
		getEnvApiKey("amazon-bedrock") !== undefined || hasAwsSharedConfig(),
	authInstructions:
		"Run `aws configure` or `aws sso login`, or set AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY / AWS_BEARER_TOKEN_BEDROCK in your environment.",
};
