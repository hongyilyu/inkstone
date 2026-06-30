// The single source of truth for the chat-enabled-model membership rule
// (ADR-0024). A PURE LEAF — imports nothing — so every consumer (the composer
// ModelPicker, the per-provider ModelCatalogTable) reads ONE answer for "is this
// model enabled for chat" and "which models are enabled".
//
// The rule: an EMPTY `enabled_models` set is the "uncurated" sentinel meaning
// "all models enabled" (never "enable nothing"); a non-empty set enables only
// its members. This mirrors Core, which stores/returns `[]` for an uncurated
// user and expands empty → all only as an internal effective set.

/** Whether `id` is enabled for chat given the curated `enabledIds` set. */
export function isModelEnabled(
	enabledIds: readonly string[],
	id: string,
): boolean {
	return enabledIds.length === 0 || enabledIds.includes(id);
}

/** The subset of `models` enabled for chat. Empty `enabledIds` → all of them. */
export function filterEnabledModels<T extends { id: string }>(
	models: readonly T[],
	enabledIds: readonly string[],
): readonly T[] {
	if (enabledIds.length === 0) return models;
	const allow = new Set(enabledIds);
	return models.filter((m) => allow.has(m.id));
}
