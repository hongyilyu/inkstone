import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Drift guard (ADR-0024): Core embeds the `openai-codex` model catalog as a
 * JSON file hand-mirrored from `pi-ai`'s `MODELS`. This test re-derives the
 * catalog from the installed `pi-ai` and asserts the committed JSON matches it
 * exactly — so a `pi-ai` bump that adds/removes/retypes an `openai-codex` model
 * fails CI here, prompting a regenerate of the JSON rather than silent drift.
 *
 * `pi-ai` does not re-export `MODELS` from its package entry, and its `exports`
 * map blocks the deep `dist/models.generated.js` path via specifier, so we
 * resolve the package's main entry and import the sibling generated file by
 * absolute URL (which bypasses the exports gate).
 */
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
			cost_input: m.cost.input,
			cost_output: m.cost.output,
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
