import type { Api, Model } from "@mariozechner/pi-ai";
import { getModels } from "@mariozechner/pi-ai";
import { clearOpenRouterKey, loadOpenRouterKey } from "../persistence/auth";
import type { ProviderInfo } from "./types";

/**
 * OpenRouter — single-key API provider routing to 250+ upstream models.
 *
 * pi-ai 0.72.1's Codex/OAuth story does not apply here: OpenRouter uses
 * a plain API key (sk-or-v1-…), and pi-ai already auto-registers the
 * `openai-completions` stream that every OpenRouter model targets
 * (`baseUrl: "https://openrouter.ai/api/v1"`). So this shim is smaller
 * than Kiro or Codex — no `registerApiProvider`, no in-flight refresh
 * dedup, no `registerOAuthProvider`.
 *
 * 251 models in pi-ai 0.72.1's OpenRouter catalog as of bump. All
 * variants (`:free`, `:beta`, `:nitro`) surface unfiltered — the user
 * filters via DialogSelect's fuzzy search (see stack-plan decisions:
 * "expect user to filter"). `defaultModelId: "moonshotai/kimi-k2.6"`
 * picked as a reasonable flagship-tier default; pinned via
 * `test/openrouter-default.test.ts` against pi-ai's live registry so a
 * future rename/removal surfaces before the agent module's boot throw.
 *
 * No `listModels()` subscription-gating like Kiro does — OpenRouter's
 * model availability is per-account at the API layer, not something
 * pi-ai's registry reflects. We expose the full catalog; unauthorized
 * models error at stream time with a clear OpenRouter error.
 */

export const openrouterProvider: ProviderInfo = {
	id: "openrouter",
	displayName: "OpenRouter",
	defaultModelId: "moonshotai/kimi-k2.6",
	titleModelId: "moonshotai/kimi-k2.6",
	// Return `[]` when no key is stored so `DialogModel` hides the 251
	// rows until the user authenticates. Otherwise the picker would
	// list every model and a pick would fail at stream time with
	// `No API key for provider: openrouter`.
	listModels: (): Model<Api>[] => {
		if (!loadOpenRouterKey()) return [];
		return getModels("openrouter");
	},
	// Synchronous — no refresh cycle, no network round-trip. pi-agent-
	// core's `getApiKey` hook awaits regardless, so the non-async
	// return is safe.
	getApiKey: () => loadOpenRouterKey(),
	isConnected: () => loadOpenRouterKey() !== undefined,
	clearCreds: () => clearOpenRouterKey(),
};
