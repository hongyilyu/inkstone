import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drift guard for the embedded openai-codex catalog (ADR-0024) — see docs/design/worker-tests.md
describe("model catalog drift", () => {
	it("crates/core/src/models/openai-codex.json is a subset of pi-ai MODELS['openai-codex'], field-exact on each retained model", async () => {
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

		// Index pi-ai's openai-codex models by id, projected to the retained
		// ModelInfo subset (`cost` was dropped in the feature-cut sweep — see
		// docs/design/worker-tests.md).
		const fromPi = new Map(
			Object.values(MODELS["openai-codex"]).map((m) => [
				m.id,
				{ id: m.id, name: m.name, reasoning: !!m.reasoning, input: m.input },
			]),
		);

		const jsonUrl = new URL(
			"../../../crates/core/src/models/openai-codex.json",
			import.meta.url,
		);
		const json = JSON.parse(readFileSync(jsonUrl, "utf8")) as {
			providers: {
				id: string;
				label: string;
				models: {
					id: string;
					name: string;
					reasoning: boolean;
					input: string[];
				}[];
			}[];
		};
		const provider = json.providers.find((p) => p.id === "openai-codex");
		expect(
			provider,
			"openai-codex provider present in embedded JSON",
		).toBeDefined();

		// The embedded catalog is a deliberately CURATED subset of pi-ai's
		// openai-codex models (product policy trims it — e.g. to gpt-5.5 only), so a
		// raw deep-equals against the full pi-ai list is wrong. The drift invariant
		// is two-part: (1) every embedded model id still exists upstream (a removed
		// or renamed upstream id trips it), and (2) each retained entry's
		// {id,name,reasoning,input} matches pi-ai EXACTLY (an upstream field change
		// to a model we ship trips it). What it intentionally does NOT enforce is
		// that we ship every upstream model — that's the curation.
		for (const model of provider?.models ?? []) {
			const upstream = fromPi.get(model.id);
			expect(
				upstream,
				`embedded model ${model.id} still present in pi-ai MODELS['openai-codex']`,
			).toBeDefined();
			expect(
				model,
				`embedded model ${model.id} matches pi-ai field-for-field`,
			).toEqual(upstream);
		}
	});
});
