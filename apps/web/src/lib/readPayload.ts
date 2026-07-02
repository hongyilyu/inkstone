// Defensive readers for UNVALIDATED wire payloads (ADR-0014): a proposed-mutation
// or intent-graph payload crosses the UI boundary as `unknown` — possibly null,
// missing keys, or wrong-typed raw model output. Each reader coerces one key off
// an unknown record to a concrete type, degrading anything unexpected to a safe
// default rather than throwing (Core still owns accept-time validation). The
// single source for `proposalEdit`, `intentGraphReview`, and (re-exported) the
// ProposalCard's `proposalPayload` helpers.

/** Read `key` off `source` as a string, degrading anything else to "". */
export function readString(source: unknown, key: string): string {
	if (source && typeof source === "object" && key in source) {
		const value = (source as Record<string, unknown>)[key];
		if (typeof value === "string") return value;
	}
	return "";
}

/** Read `key` off `source` as a plain object, degrading anything else to null. */
export function readObject(
	source: unknown,
	key: string,
): Record<string, unknown> | null {
	if (source && typeof source === "object" && key in source) {
		const value = (source as Record<string, unknown>)[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	}
	return null;
}

/** Read `key` off `source` as a `string[]`, dropping non-string entries; [] otherwise. */
export function readStringArray(source: unknown, key: string): string[] {
	if (source && typeof source === "object" && key in source) {
		const value = (source as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			return value.filter((a): a is string => typeof a === "string");
		}
	}
	return [];
}
