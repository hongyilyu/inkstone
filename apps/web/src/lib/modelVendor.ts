// Vendor (the model MAKER — OpenAI, Anthropic, Google…) as a view over the
// model catalog. A PURE LEAF — imports only the wire type — so the settings
// table and the composer picker read ONE answer for "who makes this model" and
// "how do I show its name" without duplicating the parsing rule.
//
// Vendor is distinct from PROVIDER (how the model is REACHED — the Codex OAuth
// backend vs the OpenRouter API). pi-ai already encodes vendor two ways:
//   • OpenRouter names carry a "Vendor: Model" prefix ("Anthropic: Claude Opus
//     4.8") and ids a "vendor/model" prefix ("anthropic/claude-opus-4.8").
//   • Codex names/ids are bare ("GPT-5.5" / "gpt-5.5"), so the vendor is the
//     provider's own label (Codex → OpenAI).
// So vendor derives from the name prefix, falling back to the provider label.

import type { ModelInfo } from "@inkstone/protocol";

/** The vendor that makes `model`. The "Vendor: …" name prefix when present
 * (OpenRouter), else `providerLabel` (Codex's bare names → its own label). */
export function vendorOf(
	model: Pick<ModelInfo, "name">,
	providerLabel: string,
): string {
	const idx = model.name.indexOf(": ");
	return idx > 0 ? model.name.slice(0, idx) : providerLabel;
}

/** `model`'s name with the redundant "Vendor: " prefix stripped, so a row under
 * a vendor header reads "Claude Opus 4.8", not "Anthropic: Claude Opus 4.8".
 * Names without the prefix (Codex) are returned unchanged. */
export function modelDisplayName(model: Pick<ModelInfo, "name">): string {
	const idx = model.name.indexOf(": ");
	return idx > 0 ? model.name.slice(idx + 2) : model.name;
}

export interface VendorGroup {
	readonly vendor: string;
	readonly models: readonly ModelInfo[];
}

/** Group `models` by vendor, preserving first-seen order for both the vendors
 * and the models within each (the catalog's curated order). */
export function groupByVendor(
	models: readonly ModelInfo[],
	providerLabel: string,
): readonly VendorGroup[] {
	const groups: { vendor: string; models: ModelInfo[] }[] = [];
	const byVendor = new Map<string, { vendor: string; models: ModelInfo[] }>();
	for (const model of models) {
		const vendor = vendorOf(model, providerLabel);
		let group = byVendor.get(vendor);
		if (group === undefined) {
			group = { vendor, models: [] };
			byVendor.set(vendor, group);
			groups.push(group);
		}
		group.models.push(model);
	}
	return groups;
}
