import type { Api, Model } from "@mariozechner/pi-ai";
import { getModels } from "@mariozechner/pi-ai";
import {
	getOAuthApiKey,
	type OAuthCredentials,
} from "@mariozechner/pi-ai/oauth";
import {
	clearOpenAICodexCreds,
	loadOpenAICodexCreds,
	saveOpenAICodexCreds,
} from "../persistence/auth";
import { reportPersistenceError } from "../persistence/errors";
import type { ProviderInfo } from "./types";

/**
 * OpenAI Codex — the ChatGPT Plus/Pro OAuth provider.
 *
 * pi-ai's `openai-codex-responses` API and `openaiCodexOAuthProvider` are
 * auto-registered at module load (`pi-ai/utils/oauth/index.js:30-36` +
 * `providers/register-builtins`), so this shim only has to (a) handle
 * credential persistence, (b) dedup concurrent refresh, and (c) report
 * connection state to `DialogModel` / `DialogProvider`. No
 * `registerApiProvider` call — contrast with `./kiro.ts`, which does
 * register `kiro-api` because pi-kiro isn't a pi-ai built-in.
 *
 * pi-ai's `getOAuthApiKey("openai-codex", credsMap)` handles the
 * expiry check and rotation in one call — `credsMap` is keyed by
 * provider id (`utils/oauth/index.js:115`), returns
 * `{ newCredentials, apiKey }` on success or `null` when creds are
 * missing, **throws** on refresh failure (`index.js:121-126`). We wrap
 * the throw so Inkstone's `getApiKey()` contract ("must not throw",
 * per `pi-agent-core/dist/types.d.ts`) is honored.
 */

/**
 * In-flight refresh promise, shared across concurrent callers. Same
 * rationale as Kiro's `inflight` memo (`./kiro.ts`): two near-
 * simultaneous streams or a post-sleep wake otherwise race the same
 * refresh token against OpenAI's `/oauth/token` endpoint — the rotation
 * invalidates the loser, which then evicts the user mid-session. The
 * slot clears via `.finally` so a failed refresh doesn't pin it.
 */
let inflight: Promise<OAuthCredentials | undefined> | null = null;

async function refreshIfNeeded(): Promise<OAuthCredentials | undefined> {
	if (inflight) return inflight;
	inflight = doRefresh().finally(() => {
		inflight = null;
	});
	return inflight;
}

async function doRefresh(): Promise<OAuthCredentials | undefined> {
	const creds = loadOpenAICodexCreds();
	if (!creds) return undefined;
	// Early return on still-valid tokens. Mirrors Kiro's `kiro.ts:63`.
	// Without this, every LLM turn on a healthy session round-trips
	// through `getOAuthApiKey` and `saveOpenAICodexCreds` below —
	// `getOAuthApiKey` returns the same `creds` object by reference
	// on the non-expired branch (`utils/oauth/index.js:115, 128-129`),
	// so the atomic-write rename-dance would fire once per turn for
	// no content change.
	if (Date.now() < creds.expires) return creds;
	try {
		const result = await getOAuthApiKey("openai-codex", {
			"openai-codex": creds,
		});
		if (!result) return undefined;
		// Only reached on actual refresh (the early-return above
		// filters out the no-op case). Persist rotated creds through
		// the atomic-write path.
		saveOpenAICodexCreds(result.newCredentials);
		return result.newCredentials;
	} catch (err) {
		// Clear so `isConnected()` reports correctly and the Connect
		// dialog's disconnected branch routes the next click to
		// re-login, not manage-menu.
		clearOpenAICodexCreds();
		reportPersistenceError({
			kind: "auth",
			action: "refresh",
			error: new Error(
				"ChatGPT credentials expired and refresh failed. Run Connect → ChatGPT to sign in again.",
			),
		});
		// Raw cause stays in console for debug, out of the toast: a
		// future pi-ai fetch error could theoretically include token
		// bytes in the message. Matches Kiro's posture.
		console.error("[inkstone] openai-codex refresh failed:", err);
		return undefined;
	}
}

function listOpenAICodexModels(): Model<Api>[] {
	// Signed-out: hide from DialogModel entirely. getModels() is static,
	// returning it when not connected would leak model rows into the
	// picker with no working `getApiKey()` behind them.
	if (!loadOpenAICodexCreds()) return [];
	return getModels("openai-codex");
}

export const openaiCodexProvider: ProviderInfo = {
	id: "openai-codex",
	displayName: "ChatGPT",
	// Flagship reasoning model in pi-ai 0.69.0's generated registry.
	// Pinned via `test/openai-codex-default.test.ts` so a future pi-ai
	// rename / removal surfaces there before the agent module's own
	// "default no longer resolves" boot throw.
	defaultModelId: "gpt-5.4",
	listModels: listOpenAICodexModels,
	// Async because refresh may need a network round-trip. pi-agent-core
	// awaits this (`agent-loop.js:156`).
	getApiKey: async () => {
		const creds = await refreshIfNeeded();
		return creds?.access;
	},
	isConnected: () => loadOpenAICodexCreds() !== undefined,
	clearCreds: () => clearOpenAICodexCreds(),
};
