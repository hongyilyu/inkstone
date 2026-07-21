import type {
	ProviderStatusResult,
	ProviderTestResult,
} from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { Effect } from "effect";
import { runSquashed } from "../lib/runSquashed.js";
import type { WsRuntime } from "../runtime.js";

// Thin imperative bridge between the settings UI and the SDK provider/* methods (ADR-0023); no store state of its own.

/** Read the full `provider/status` payload (all providers + their connected flags). */
export async function fetchProviderStatus(
	runtime: WsRuntime,
): Promise<ProviderStatusResult> {
	const program = Effect.flatMap(WsClient, (client) => client.providerStatus());
	return runtime.runPromise(program);
}

/** How to open the authorize URL — `window.open` in prod, a spy in tests. */
export type OpenUrl = (url: string) => void;

const defaultOpenUrl: OpenUrl = (url) => {
	window.open(url, "_blank", "noopener,noreferrer");
};

/** Begin a provider login: fetch the authorize URL and open it in a new tab
 * (credential write happens out-of-band). Rejects with the real `WsError` via
 * {@link runSquashed} (e.g. `ProviderLoginFailedError` carrying Core's sanitized
 * reason), so the caller's catch can branch on `_tag`. */
export async function startLogin(
	runtime: WsRuntime,
	provider: string,
	openUrl: OpenUrl = defaultOpenUrl,
): Promise<void> {
	const { authorize_url } = await runSquashed(
		runtime,
		Effect.flatMap(WsClient, (client) => client.providerLoginStart(provider)),
	);
	openUrl(authorize_url);
}

/** Configure a key-provider: store the pasted API key via `provider/configure`
 * (ADR-0062). Resolves to the refreshed `provider/status`, so the caller flips
 * the row through the same live-refresh chokepoint a login uses. */
export async function configure(
	runtime: WsRuntime,
	provider: string,
	apiKey: string,
): Promise<ProviderStatusResult> {
	const program = Effect.flatMap(WsClient, (client) =>
		client.providerConfigure(provider, apiKey),
	);
	return runtime.runPromise(program);
}

/** Probe a provider's liveness with a specific model via `provider/test`
 * (ADR-0062). Provider-agnostic and transient — nothing is persisted; the caller
 * renders the returned `{alive, message?}` verdict as ephemeral UI state. */
export async function test(
	runtime: WsRuntime,
	provider: string,
	model: string,
): Promise<ProviderTestResult> {
	const program = Effect.flatMap(WsClient, (client) =>
		client.providerTest(provider, model),
	);
	return runtime.runPromise(program);
}
