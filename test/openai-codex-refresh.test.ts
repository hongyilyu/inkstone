/**
 * Tests for the OpenAI Codex provider's lazy refresh path.
 *
 * Focus: the same C1/H1 regression class that `test/kiro-refresh.test.ts`
 * pins for Kiro —
 *   (a) concurrent `getApiKey()` calls must share one refresh promise
 *       so OpenAI's `/oauth/token` endpoint isn't hit twice.
 *   (b) `getApiKey()` must not throw when refresh fails — pi-agent-core
 *       documents that `getApiKey` "must not throw or reject"
 *       (`@mariozechner/pi-agent-core/dist/types.d.ts`). pi-ai's
 *       `getOAuthApiKey` *does* throw on refresh failure
 *       (`pi-ai/utils/oauth/index.js:121-126`); the provider shim's
 *       job is to wrap that throw.
 *   (c) `isConnected()` reports correctly after the catch path clears
 *       creds.
 *
 * Strategy: replace pi-ai's `openaiCodexOAuthProvider.refreshToken` with
 * a stub, seed `auth.json` with creds whose `expires` is in the past,
 * and call `openaiCodexProvider.getApiKey()` concurrently / under
 * failure. Auth file writes are scoped to the tmp XDG_CONFIG_HOME set
 * by `test/preload.ts`, so nothing touches the dev machine's real
 * `~/.config/inkstone/`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let refreshCalls = 0;
let refreshDelayMs = 0;
let refreshShouldThrow = false;

function makeCreds(expiresMs: number, seed: string) {
	return {
		access: `access-${seed}`,
		refresh: `refresh-${seed}`,
		expires: expiresMs,
		accountId: `account-${seed}`,
	};
}

// pi-ai's `getOAuthApiKey` looks up the provider via
// `getOAuthProvider(id)` at every call (`utils/oauth/index.js:111`),
// and the returned object is what supplies `refreshToken`. Overriding
// `openaiCodexOAuthProvider` at export-time would be a no-op because
// pi-ai's own registry was populated at module-eval BEFORE `mock.module`
// ran — the in-memory `oauthProviderRegistry` Map holds the unmocked
// object. So the `getOAuthProvider` override is the only load-bearing
// piece here.
const realOauth = await import("@mariozechner/pi-ai/oauth");
mock.module("@mariozechner/pi-ai/oauth", () => ({
	...realOauth,
	getOAuthProvider: (id: string) => {
		if (id === "openai-codex") {
			return {
				...realOauth.openaiCodexOAuthProvider,
				refreshToken: async (_creds: unknown) => {
					refreshCalls += 1;
					if (refreshDelayMs) {
						await new Promise((r) => setTimeout(r, refreshDelayMs));
					}
					if (refreshShouldThrow) {
						throw new Error("simulated refresh failure");
					}
					return makeCreds(Date.now() + 60_000, `refreshed-${refreshCalls}`);
				},
			};
		}
		return realOauth.getOAuthProvider(id);
	},
}));

// Import after the mock so the provider module resolves `getOAuthApiKey`
// through the mocked version.
const { openaiCodexProvider } = await import(
	"../src/backend/providers/openai-codex"
);
const { saveOpenAICodexCreds, clearOpenAICodexCreds } = await import(
	"../src/backend/persistence/auth"
);

function seedExpiredCreds(): void {
	clearOpenAICodexCreds();
	saveOpenAICodexCreds(makeCreds(Date.now() - 1000, "expired"));
}

describe("openai-codex refresh", () => {
	beforeEach(() => {
		refreshCalls = 0;
		refreshDelayMs = 0;
		refreshShouldThrow = false;
		clearOpenAICodexCreds();
	});

	test("concurrent getApiKey calls share one refresh", async () => {
		refreshDelayMs = 20;
		seedExpiredCreds();

		const [a, b] = await Promise.all([
			openaiCodexProvider.getApiKey(),
			openaiCodexProvider.getApiKey(),
		]);

		expect(refreshCalls).toBe(1);
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		// Both callers observe the SAME refreshed access token.
		expect(a).toBe(b);
	});

	test("getApiKey returns undefined on refresh failure, does not throw", async () => {
		refreshShouldThrow = true;
		seedExpiredCreds();

		// Must not reject. pi-ai's `getOAuthApiKey` throws on refresh
		// failure; the provider shim wraps that in a `try`, reports
		// via `reportPersistenceError`, and returns `undefined`.
		const key = await openaiCodexProvider.getApiKey();

		expect(key).toBeUndefined();
	});

	test("isConnected returns false after refresh failure clears creds", async () => {
		refreshShouldThrow = true;
		seedExpiredCreds();

		await openaiCodexProvider.getApiKey();

		// The catch branch called `clearOpenAICodexCreds()`, so
		// `isConnected()` should report accordingly.
		expect(openaiCodexProvider.isConnected()).toBe(false);
	});
});
