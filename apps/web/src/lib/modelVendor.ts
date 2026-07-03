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

/** Split a `"Vendor: Model"` name into its two parts on the FIRST `": "`, or
 * `null` for a bare name (no prefix, or a leading `": "`). The single source of
 * the prefix rule, so `vendorOf` and `modelDisplayName` can't drift apart. */
function splitVendorPrefix(
	name: string,
): { vendor: string; rest: string } | null {
	const idx = name.indexOf(": ");
	return idx > 0
		? { vendor: name.slice(0, idx), rest: name.slice(idx + 2) }
		: null;
}

/** The vendor that makes `model`. The "Vendor: …" name prefix when present
 * (OpenRouter), else `providerLabel` (Codex's bare names → its own label). */
export function vendorOf(
	model: Pick<ModelInfo, "name">,
	providerLabel: string,
): string {
	return splitVendorPrefix(model.name)?.vendor ?? providerLabel;
}

/** `model`'s name with the redundant "Vendor: " prefix stripped, so a row under
 * a vendor header reads "Claude Opus 4.8", not "Anthropic: Claude Opus 4.8".
 * Names without the prefix (Codex) are returned unchanged. */
export function modelDisplayName(model: Pick<ModelInfo, "name">): string {
	return splitVendorPrefix(model.name)?.rest ?? model.name;
}

export interface VendorGroup {
	readonly vendor: string;
	readonly models: readonly ModelInfo[];
}

/** Group `models` by vendor, preserving first-seen order for both the vendors
 * and the models within each (the catalog's curated order). A `Map` already
 * iterates in insertion order, so it alone carries the vendor ordering. */
export function groupByVendor(
	models: readonly ModelInfo[],
	providerLabel: string,
): readonly VendorGroup[] {
	const byVendor = new Map<string, ModelInfo[]>();
	for (const model of models) {
		const vendor = vendorOf(model, providerLabel);
		const group = byVendor.get(vendor);
		if (group === undefined) byVendor.set(vendor, [model]);
		else group.push(model);
	}
	return [...byVendor].map(([vendor, models]) => ({ vendor, models }));
}
