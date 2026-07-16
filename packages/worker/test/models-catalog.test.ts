import { readFileSync } from "node:fs";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

// The embedded catalog SOURCE is vendor-owned (ADR-0024): `vendors` each own
// their models by bare `key`; `providers` only declare which vendors they reach.
// Core (crates/core/src/models/mod.rs) derives the per-provider catalog from it.
// This test re-derives the same way and drift-checks each derived model against
// pi-ai — so a pi-ai bump that adds/removes/retypes a shipped model fails CI.
interface VendorModel {
	key: string;
	name: string;
	reasoning: boolean;
	input: string[];
}
interface Vendor {
	id: string;
	label: string;
	models: VendorModel[];
}
interface Reach {
	vendor: string;
	models?: string[];
}
interface Provider {
	id: string;
	label: string;
	id_style: "bare" | "prefixed";
	reaches: Reach[];
}
interface SourceCatalog {
	vendors: Vendor[];
	providers: Provider[];
}

function source(): SourceCatalog {
	const jsonUrl = new URL(
		"../../../crates/core/src/models/catalog.json",
		import.meta.url,
	);
	return JSON.parse(readFileSync(jsonUrl, "utf8")) as SourceCatalog;
}

// Mirror of Core's derivation: expand a provider's `reaches` against the vendor
// lists into concrete { id } models (the id is all the drift check needs).
function derive(
	src: SourceCatalog,
): { id: string; models: { id: string }[] }[] {
	const vendors = new Map(src.vendors.map((v) => [v.id, v]));
	return src.providers.map((provider) => ({
		id: provider.id,
		models: provider.reaches.flatMap((reach) => {
			const vendor = vendors.get(reach.vendor);
			if (!vendor) throw new Error(`unknown vendor ${reach.vendor}`);
			const keys = reach.models ?? vendor.models.map((m) => m.key);
			return keys.map((key) => ({
				id: provider.id_style === "bare" ? key : `${vendor.id}/${key}`,
			}));
		}),
	}));
}

type PiModels = Record<
	string,
	Record<string, { id: string; reasoning: boolean; input: string[] }>
>;

// Index pi-ai's public registry — the same `builtinModels()` collection the
// interpreter resolves models from at runtime — as provider id → model id.
function piModels(): PiModels {
	const models = builtinModels();
	const byProvider: PiModels = {};
	for (const provider of models.getProviders()) {
		byProvider[provider.id] = Object.fromEntries(
			models.getModels(provider.id).map((m) => [m.id, m] as const),
		);
	}
	return byProvider;
}

describe("model catalog drift", () => {
	// Each vendor is a deliberately CURATED subset of pi-ai (product policy trims
	// it), so a raw deep-equals is wrong. The invariant: every DERIVED model id
	// still exists in pi-ai's registry for that provider, and its capability fields
	// ({reasoning, input}) match pi-ai EXACTLY. The display NAME is intentionally
	// NOT pinned — it is vendor-owned (defined once) and derived (a `prefixed`
	// provider prepends the vendor label), whereas pi-ai names the same model
	// inconsistently across providers (e.g. "GPT-5.4 mini" vs "GPT-5.4 Mini").
	it("every derived model id still exists in pi-ai (unique per provider)", () => {
		const modelsByProvider = piModels();
		const derived = derive(source());
		expect(derived.length, "catalog has providers").toBeGreaterThan(0);

		for (const provider of derived) {
			const upstream = modelsByProvider[provider.id];
			expect(
				upstream,
				`pi-ai's registry has a '${provider.id}' provider`,
			).toBeDefined();

			expect(
				provider.models.length,
				`${provider.id} derives models`,
			).toBeGreaterThan(0);

			const ids = provider.models.map((m) => m.id);
			expect(new Set(ids).size, `${provider.id} model ids are unique`).toBe(
				ids.length,
			);

			for (const model of provider.models) {
				expect(
					upstream[model.id],
					`derived model ${model.id} still present in pi-ai's '${provider.id}' registry`,
				).toBeDefined();
			}
		}
	});

	// Field-exact check on the source vendor models' own capability fields: the
	// {reasoning, input} we author must equal pi-ai's for the same model, under
	// whichever provider serves it. Split from the id-existence check above so a
	// failure names the vendor model, not just the derived id.
	it("each vendor model's reasoning + input match pi-ai", () => {
		const modelsByProvider = piModels();
		const src = source();

		// Build vendorId → the pi-ai record for that model, via any provider that
		// reaches it (capabilities agree across providers; only names differ).
		const reachOf = new Map<string, Provider>();
		for (const p of src.providers)
			for (const r of p.reaches)
				if (!reachOf.has(r.vendor)) reachOf.set(r.vendor, p);

		for (const vendor of src.vendors) {
			const provider = reachOf.get(vendor.id);
			expect(
				provider,
				`vendor ${vendor.id} is reached by a provider`,
			).toBeDefined();
			if (!provider) continue;
			const group = modelsByProvider[provider.id];
			for (const m of vendor.models) {
				const id =
					provider.id_style === "bare" ? m.key : `${vendor.id}/${m.key}`;
				const up = group[id];
				expect(
					up,
					`vendor model ${vendor.id}/${m.key} present in pi-ai (as ${id})`,
				).toBeDefined();
				expect(
					{ reasoning: m.reasoning, input: m.input },
					`vendor model ${vendor.id}/${m.key} matches pi-ai reasoning + input`,
				).toEqual({ reasoning: up.reasoning, input: up.input });
			}
		}
	});
});
