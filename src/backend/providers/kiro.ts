import type { Api, Model } from "@mariozechner/pi-ai";
import { registerApiProvider } from "@mariozechner/pi-ai";
import type { KiroCredentials } from "pi-kiro/core";
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
import { reportPersistenceError } from "../persistence/errors";
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
 * In-flight refresh promise, shared across concurrent callers so that a
 * burst of near-simultaneous `getApiKey()` calls (two streams, two tabs,
 * post-sleep wake, etc.) issues exactly one refresh request to AWS SSO.
 *
 * Without dedup, both callers race the same refresh token against the
 * OIDC endpoint; AWS rotates the token, the loser gets `invalid_grant`
 * and hits the catch branch which clears creds — evicting the user
 * mid-session for no reason. Cleared in `finally` so a failed refresh
 * doesn't pin the slot forever.
 */
let inflight: Promise<KiroCredentials | undefined> | null = null;

/**
 * Lazy token refresh. Called from `getApiKey()` only (not from
 * `listModels()`, which needs `creds.region` and is stable across
 * refreshes). Concurrent callers share one in-flight promise; on
 * refresh failure clears creds and returns `undefined` so pi-agent-
 * core's `getApiKey` contract (must not throw) is honored — the
 * subsequent stream fails with a 401 and the user is surfaced a toast
 * via `reportPersistenceError`, nudging them back through Connect.
 */
async function refreshIfNeeded(): Promise<KiroCredentials | undefined> {
	if (inflight) return inflight;
	inflight = doRefresh().finally(() => {
		inflight = null;
	});
	return inflight;
}

async function doRefresh(): Promise<KiroCredentials | undefined> {
	const creds = loadKiroCreds();
	if (!creds) return undefined;
	if (Date.now() <= creds.expires) return creds;
	try {
		const fresh = await refreshKiroToken(creds);
		saveKiroCreds(fresh);
		return fresh;
	} catch (err) {
		clearKiroCreds();
		reportPersistenceError({
			kind: "auth",
			action: "refresh",
			error: new Error(
				"Kiro credentials expired and refresh failed. Run Connect → Amazon Kiro to sign in again.",
			),
		});
		// Log raw cause for debugging, but keep it out of the user-facing
		// toast (pi-kiro's fetch error body could theoretically include
		// token bytes in a future upstream change).
		console.error("[inkstone] kiro refresh failed:", err);
		return undefined;
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
