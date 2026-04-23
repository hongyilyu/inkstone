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
// `streamSimple(model, ...)` (which is pi-agent-core's default `streamFn`)
// can resolve and dispatch Kiro requests. pi-kiro's `streamKiro` accepts
// exactly the `SimpleStreamOptions` shape so it slots in as both `stream`
// and `streamSimple`.
//
// Side-effect at module load. `providers/index.ts` imports this module so
// registration fires before `backend/agent/index.ts` resolves any model.
registerApiProvider({
	api: "kiro-api",
	stream: streamKiro,
	streamSimple: streamKiro,
});

/**
 * Lazy refresh. Called from both `listModels()` (to advertise fresh-region-
 * scoped model ids) and `getApiKey()` (to ensure the token handed to the
 * stream is valid). Writes refreshed creds back to disk and the in-memory
 * cache. Clears and throws on hard refresh failure so the user is pushed
 * back through /connect instead of seeing opaque 403s mid-stream.
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
 * Region-scoped, baseUrl-rewritten model list.
 *
 * pi-kiro ships one canonical `kiroModels` catalog; per-region availability
 * is a runtime filter (`filterModelsByRegion`) and the baseUrl has to be
 * rewritten to point at the user's API region (`q.{region}.amazonaws.com`).
 * Without this, every Kiro stream would hit us-east-1 regardless of the
 * token's issuing region. Mirrors pi-kiro's `modifyModels` hook in
 * `extension.ts:32-41`, applied here because we consume pi-kiro through
 * `/core` (not pi's extension runtime).
 *
 * Returns `[]` when not signed in — drives `DialogModel`'s empty-state and
 * keeps Kiro models out of the flat picker until the user authenticates.
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
