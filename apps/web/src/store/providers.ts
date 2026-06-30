import type { ProviderStatusResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { Effect } from "effect";
import type { WsRuntime } from "../runtime.js";

// Thin imperative bridge between the settings UI and the SDK provider/* methods (ADR-0023); no store state of its own.
export const PROVIDER_OPENAI_CODEX = "openai-codex";

/** Read the full `provider/status` payload (all providers + their connected flags). */
export async function fetchProviderStatus(
	runtime: WsRuntime,
): Promise<ProviderStatusResult> {
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.providerStatus();
	});
	return runtime.runPromise(program);
}

/** How to open the authorize URL — `window.open` in prod, a spy in tests. */
export type OpenUrl = (url: string) => void;

const defaultOpenUrl: OpenUrl = (url) => {
	window.open(url, "_blank", "noopener,noreferrer");
};

/** Begin a provider login: fetch the authorize URL and open it in a new tab (credential write happens out-of-band). */
export async function startLogin(
	runtime: WsRuntime,
	provider: string,
	openUrl: OpenUrl = defaultOpenUrl,
): Promise<void> {
	const program = Effect.gen(function* () {
		const client = yield* WsClient;
		return yield* client.providerLoginStart(provider);
	});
	const { authorize_url } = await runtime.runPromise(program);
	openUrl(authorize_url);
}
