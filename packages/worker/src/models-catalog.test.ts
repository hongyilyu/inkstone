import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drift guard for the embedded openai-codex catalog (ADR-0024) — see docs/design/worker-tests.md
describe("model catalog drift", () => {
	it("crates/core/src/models/openai-codex.json equals pi-ai MODELS['openai-codex']", async () => {
		const mainUrl = import.meta.resolve("@earendil-works/pi-ai");
		const genUrl = new URL("./models.generated.js", mainUrl);
		const { MODELS } = (await import(genUrl.href)) as {
			MODELS: Record<
				string,
				Record<
					string,
					{
						id: string;
						name: string;
						reasoning?: boolean;
						input: string[];
						cost: { input: number; output: number };
					}
				>
			>;
		};

		const fromPi = Object.values(MODELS["openai-codex"]).map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: !!m.reasoning,
			input: m.input,
		}));

		const jsonUrl = new URL(
			"../../../crates/core/src/models/openai-codex.json",
			import.meta.url,
		);
		const json = JSON.parse(readFileSync(jsonUrl, "utf8")) as {
			providers: { id: string; label: string; models: unknown[] }[];
		};
		const provider = json.providers.find((p) => p.id === "openai-codex");
		expect(
			provider,
			"openai-codex provider present in embedded JSON",
		).toBeDefined();

		expect(provider?.models).toEqual(fromPi);
	});
});
