import type { Api, Model } from "@mariozechner/pi-ai";
import { registerApiProvider } from "@mariozechner/pi-ai";
import {
	filterModelsByRegion,
	kiroModels,
	refreshKiroToken,
	resolveApiRegion,
	streamKiro,
} from "pi-kiro/core";
import {
	clearKiroCreds,
	loadKiroCreds,
	saveKiroCreds,
} from "../persistence/auth";
import type { ProviderInfo } from "./types";

// Register the `kiro-api` with pi-ai's api-registry so pi-ai's
// `streamSimple(model, ...)` can dispatch to pi-kiro. Side-effect at
// module load; `providers/index.ts` imports this module so registration
// fires before the agent module resolves any model. See
// `docs/ARCHITECTURE.md` § Kiro provider for the full flow.
registerApiProvider({
	api: "kiro-api",
	stream: streamKiro,
	streamSimple: streamKiro,
});

/**
 * Lazy token refresh. Called from `getApiKey()` (and `listModels()` via
 * `loadKiroCreds`) — see `docs/ARCHITECTURE.md` § Kiro provider. Clears
 * creds and throws on hard refresh failure so the user is pushed back
 * through Connect instead of seeing opaque 403s mid-stream.
 */
async function refreshIfNeeded(): Promise<
	ReturnType<typeof loadKiroCreds> | undefined
> {
	const creds = loadKiroCreds();
	if (!creds) return undefined;
	if (Date.now() <= creds.expires) return creds;
	try {
		const fresh = await refreshKiroToken(creds);
		saveKiroCreds(fresh);
		return fresh;
	} catch (err) {
		clearKiroCreds();
		throw new Error(
			`Kiro credentials expired and refresh failed (${
				err instanceof Error ? err.message : String(err)
			}). Run Connect → Amazon Kiro to sign in again.`,
		);
	}
}

/**
 * Region-scoped, baseUrl-rewritten model list. Returns `[]` when not
 * signed in so `DialogModel` hides Kiro until the user authenticates.
 * See `docs/ARCHITECTURE.md` § Kiro provider for the region-scoping
 * rationale and the `modifyModels` parallel.
 */
function listKiroModels(): Model<Api>[] {
	const creds = loadKiroCreds();
	if (!creds) return [];
	const apiRegion = resolveApiRegion(creds.region);
	// Every `kiroModels` entry ships with the same placeholder baseUrl
	// (us-east-1) — compute the region-scoped URL once instead of per-model.
	const baseUrl = `https://q.${apiRegion}.amazonaws.com/generateAssistantResponse`;
	return filterModelsByRegion(kiroModels, apiRegion).map((m) => ({
		...m,
		baseUrl,
	}));
}

export const kiroProvider: ProviderInfo = {
	id: "kiro",
	displayName: "Amazon Kiro",
	// claude-opus-4-7 is in both us-east-1 and eu-central-1 allowlists in
	// pi-kiro's MODELS_BY_REGION — safe default for any issuing region.
	defaultModelId: "claude-opus-4-7",
	listModels: listKiroModels,
	// Async because refresh may need a network round-trip. pi-agent-core
	// awaits this (`agent-loop.js:156`).
	getApiKey: async () => {
		const creds = await refreshIfNeeded();
		return creds?.access;
	},
	isConnected: () => loadKiroCreds() !== undefined,
	authInstructions:
		"Run Connect → Amazon Kiro to sign in with AWS Builder ID or IAM Identity Center.",
};
