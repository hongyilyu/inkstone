import type { ModelInfo } from "@inkstone/protocol";
import { describe, expect, it } from "vitest";
import {
	groupByVendor,
	modelDisplayName,
	vendorOf,
} from "@/lib/modelVendor.js";

const model = (id: string, name: string): ModelInfo => ({
	id,
	name,
	reasoning: true,
	input: ["text"],
});

describe("vendorOf", () => {
	it("reads the 'Vendor: …' name prefix (OpenRouter)", () => {
		expect(
			vendorOf(
				model("anthropic/claude-opus-4.8", "Anthropic: Claude Opus 4.8"),
				"OpenRouter",
			),
		).toBe("Anthropic");
		expect(
			vendorOf(model("x-ai/grok-4.3", "xAI: Grok 4.3"), "OpenRouter"),
		).toBe("xAI");
	});

	it("falls back to the provider label for bare names (Codex)", () => {
		expect(vendorOf(model("gpt-5.5", "GPT-5.5"), "OpenAI")).toBe("OpenAI");
	});

	it("splits only on the FIRST ': ', so vendors with colons in the model survive", () => {
		expect(
			vendorOf(model("z-ai/glm-5.2", "Z.ai: GLM 5.2: Turbo"), "OpenRouter"),
		).toBe("Z.ai");
	});

	it("does not treat a leading ': ' as a vendor (index 0 is falsy → provider label)", () => {
		expect(vendorOf(model("weird/x", ": Model"), "OpenRouter")).toBe(
			"OpenRouter",
		);
	});
});

describe("modelDisplayName", () => {
	it("strips the redundant 'Vendor: ' prefix", () => {
		expect(modelDisplayName(model("a", "Anthropic: Claude Opus 4.8"))).toBe(
			"Claude Opus 4.8",
		);
	});

	it("leaves a bare name unchanged (Codex)", () => {
		expect(modelDisplayName(model("gpt-5.5", "GPT-5.5"))).toBe("GPT-5.5");
	});
});

describe("groupByVendor", () => {
	it("groups by vendor, preserving first-seen order of vendors and models", () => {
		const models = [
			model("openai/gpt-5.5", "OpenAI: GPT-5.5"),
			model("anthropic/claude-opus-4.8", "Anthropic: Claude Opus 4.8"),
			model("openai/gpt-5.5-pro", "OpenAI: GPT-5.5 Pro"),
			model("google/gemini-3.5-flash", "Google: Gemini 3.5 Flash"),
		];
		const groups = groupByVendor(models, "OpenRouter");
		expect(groups.map((g) => g.vendor)).toEqual([
			"OpenAI",
			"Anthropic",
			"Google",
		]);
		// OpenAI keeps both its models in catalog order, not just the first.
		expect(groups[0].models.map((m) => m.id)).toEqual([
			"openai/gpt-5.5",
			"openai/gpt-5.5-pro",
		]);
	});

	it("puts every bare-named model under the single provider-label vendor (Codex)", () => {
		const groups = groupByVendor(
			[model("gpt-5.5", "GPT-5.5"), model("gpt-5.4-mini", "GPT-5.4 mini")],
			"OpenAI",
		);
		expect(groups).toHaveLength(1);
		expect(groups[0].vendor).toBe("OpenAI");
		expect(groups[0].models).toHaveLength(2);
	});

	it("returns no groups for an empty catalog", () => {
		expect(groupByVendor([], "OpenRouter")).toEqual([]);
	});
});
