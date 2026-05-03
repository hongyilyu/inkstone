/**
 * Pin `openaiCodexProvider.defaultModelId` against pi-ai's live model
 * registry so a future pi-ai rename / removal surfaces here before the
 * agent module's own "default no longer resolves" boot throw.
 *
 * Mirrors `test/bedrock-filter.test.ts`'s `defaultModelId` survival
 * case, trimmed — Codex has no on-demand filter.
 */

import { describe, expect, test } from "bun:test";
import { saveOpenAICodexCreds } from "../src/backend/persistence/auth";
import { openaiCodexProvider } from "../src/backend/providers/openai-codex";

describe("openai-codex default model", () => {
	test("defaultModelId resolves through the live pi-ai registry", () => {
		// `listModels()` returns `[]` when signed out (intentional — hides
		// Codex from the picker). Seed creds through the real save path so
		// `listModels()` consults pi-ai's `getModels("openai-codex")`.
		// A bogus `accountId` is fine; nothing in this test stream-calls.
		saveOpenAICodexCreds({
			access: "test-access",
			refresh: "test-refresh",
			expires: Date.now() + 60_000,
			accountId: "test-account",
		});

		const models = openaiCodexProvider.listModels();
		expect(models.length).toBeGreaterThan(0);
		expect(
			models.some((m) => m.id === openaiCodexProvider.defaultModelId),
		).toBe(true);
		expect(models.some((m) => m.id === openaiCodexProvider.titleModelId)).toBe(
			true,
		);
	});
});
