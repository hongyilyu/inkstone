/**
 * Bedrock on-demand model filter.
 *
 * Raw Anthropic IDs on Bedrock (`anthropic.claude-*`) require an
 * inference profile and fail at first stream with a ValidationException
 * under on-demand throughput. The provider's `listModels()` filters
 * them out so `DialogModel` never offers a choice that fails.
 *
 * These tests pin the filter contract against the live pi-ai registry,
 * so a pi-ai rename that drops the curated default — or shifts ID
 * shapes — is surfaced loudly.
 */

import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	bedrockProvider,
	isOnDemandBedrockModel,
} from "../src/backend/providers/amazon-bedrock";

// The filter only reads `.id` — build a minimal stub instead of a full
// Model<Api>. The cast announces the shape reduction to future readers.
const stub = (id: string): Model<Api> => ({ id }) as unknown as Model<Api>;

describe("Bedrock on-demand filter", () => {
	test("isOnDemandBedrockModel rejects raw anthropic.* ids", () => {
		expect(isOnDemandBedrockModel(stub("anthropic.claude-opus-4-7"))).toBe(
			false,
		);
		expect(isOnDemandBedrockModel(stub("anthropic.claude-sonnet-4-6"))).toBe(
			false,
		);
	});

	test("isOnDemandBedrockModel accepts regional-prefix anthropic ids", () => {
		for (const prefix of ["us.", "eu.", "apac.", "global."]) {
			expect(
				isOnDemandBedrockModel(stub(`${prefix}anthropic.claude-opus-4-7`)),
			).toBe(true);
		}
	});

	test("isOnDemandBedrockModel accepts non-anthropic vendors", () => {
		const keep = [
			"amazon.nova-2-lite-v1:0",
			"amazon.nova-pro-v1:0",
			"meta.llama3-3-70b-instruct-v1:0",
			"deepseek.r1-v1:0",
			"google.gemma-3-27b-it",
			"mistral.mistral-large-3-675b-instruct",
		];
		for (const id of keep) {
			expect(isOnDemandBedrockModel(stub(id))).toBe(true);
		}
	});

	test("listModels() hides raw anthropic.* and keeps the rest", () => {
		const models = bedrockProvider.listModels();
		// No raw `anthropic.` survives — only regional-prefix variants.
		expect(models.every((m) => !m.id.startsWith("anthropic."))).toBe(true);
		// Regional-prefix Anthropic IDs are still listed.
		expect(models.some((m) => m.id.startsWith("us.anthropic."))).toBe(true);
		expect(models.some((m) => m.id.startsWith("eu.anthropic."))).toBe(true);
		// Non-Anthropic vendors untouched.
		expect(models.some((m) => m.id.startsWith("amazon.nova"))).toBe(true);
		expect(models.some((m) => m.id.startsWith("meta.llama"))).toBe(true);
	});

	test("defaultModelId survives the filter", () => {
		// Regression guard: a pi-ai rename that drops
		// `us.anthropic.claude-opus-4-7` would leave the provider booting
		// with a default that isn't listed, and the agent module would
		// throw on first use. Catch it here instead.
		const models = bedrockProvider.listModels();
		expect(models.some((m) => m.id === bedrockProvider.defaultModelId)).toBe(
			true,
		);
	});
});
