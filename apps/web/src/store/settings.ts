import type { ModelCatalogResult, SettingsResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { Effect } from "effect";
import type { WsRuntime } from "../runtime.js";

/**
 * Imperative bridge between the React settings UI and the SDK `settings/*` +
 * `model/catalog` methods (ADR-0024). Mirrors `store/providers.ts`: no store
 * state of its own — components hold the values and call these to run the
 * Effects on the runtime.
 */

/** Read the user's preferred model + global effort for the default Workflow. */
export async function fetchSettings(
	runtime: WsRuntime,
): Promise<SettingsResult> {
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.settingsGet();
	});
	return runtime.runPromise(program);
}

/**
 * Persist a partial settings update (preferred model and/or global effort).
 * Returns the updated settings as Core re-read them.
 */
export async function saveSettings(
	runtime: WsRuntime,
	params: { readonly model?: string; readonly effort?: string },
): Promise<SettingsResult> {
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.settingsSet(params);
	});
	return runtime.runPromise(program);
}

/** Read the available models per provider (the selector's catalog). */
export async function fetchCatalog(
	runtime: WsRuntime,
): Promise<ModelCatalogResult> {
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.modelCatalog();
	});
	return runtime.runPromise(program);
}
