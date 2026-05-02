/**
 * Pin `openrouterProvider.defaultModelId` against pi-ai's live OpenRouter
 * model registry so a future pi-ai rename/removal surfaces here before
 * the agent module's boot throw.
 *
 * Mirrors `test/openai-codex-default.test.ts` trimmed — no refresh test
 * (OpenRouter uses a static API key; no refresh cycle).
 */

import { describe, expect, test } from "bun:test";
import { saveOpenRouterKey } from "../src/backend/persistence/auth";
import { openrouterProvider } from "../src/backend/providers/openrouter";

describe("openrouter default model", () => {
	test("defaultModelId resolves through the live pi-ai registry", () => {
		// `listModels()` returns `[]` when signed out (intentional — hides
		// OpenRouter from the picker). Seed a key through the real save
		// path so `listModels()` consults pi-ai's `getModels("openrouter")`.
		// The key value doesn't matter for this test — no stream calls fire.
		saveOpenRouterKey("sk-or-v1-test");

		const models = openrouterProvider.listModels();
		expect(models.length).toBeGreaterThan(0);
		expect(models.some((m) => m.id === openrouterProvider.defaultModelId)).toBe(
			true,
		);
	});

	test("listModels returns empty when signed out", async () => {
		const { clearOpenRouterKey } = await import(
			"../src/backend/persistence/auth"
		);
		clearOpenRouterKey();
		expect(openrouterProvider.isConnected()).toBe(false);
		expect(openrouterProvider.listModels()).toEqual([]);
	});

	test("all 251+ OpenRouter models surface unfiltered (variants included)", () => {
		// No filter on `:free` / `:beta` / `:nitro` — user filters via
		// DialogSelect fuzzy search per the stack-plan decision.
		saveOpenRouterKey("sk-or-v1-test");
		const models = openrouterProvider.listModels();
		// Sanity-check the catalog is meaningfully populated. pi-ai 0.72.1
		// ships 251 entries; guard against a future trim that would silently
		// shrink DialogSelect.
		expect(models.length).toBeGreaterThan(200);
		// Each model carries the provider + api expected by the auto-
		// registered `openai-completions` stream.
		for (const m of models.slice(0, 5)) {
			expect(m.provider).toBe("openrouter");
			expect(m.api).toBe("openai-completions");
			expect(m.baseUrl).toBe("https://openrouter.ai/api/v1");
		}
	});
});
