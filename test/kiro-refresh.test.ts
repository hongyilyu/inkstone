/**
 * Tests for the Kiro provider's lazy refresh path.
 *
 * Focus: the C1/H1 regression from the May 2026 audit —
 *   (a) concurrent `getApiKey()` calls must share one refresh promise
 *       (dedup), so the refresh token isn't burned twice.
 *   (b) `getApiKey()` must not throw when refresh fails — pi-agent-core
 *       documents that `getApiKey` "must not throw or reject"
 *       (`@mariozechner/pi-agent-core/dist/types.d.ts`).
 *
 * Strategy: mock `pi-kiro/core`'s `refreshKiroToken` with a delayed
 * resolver; seed `auth.json` with creds whose `expires` is in the past;
 * call `kiroProvider.getApiKey()` twice concurrently; assert the mock
 * was called once.
 *
 * Auth file writes are scoped to the tmp XDG_CONFIG_HOME set by
 * `test/preload.ts`, so nothing touches the developer's real
 * `~/.config/inkstone/`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Track refresh-call count on the mock so tests can assert dedup.
let refreshCalls = 0;
let refreshDelayMs = 0;
let refreshShouldThrow = false;

function makeFreshCreds(expiresMs: number, seed: string) {
	return {
		access: `access-${seed}`,
		refresh: `refresh-${seed}`,
		clientId: "cid",
		clientSecret: "csec",
		expires: expiresMs,
		region: "us-east-1",
		authMethod: "builder-id" as const,
	};
}

// Bun's `mock.module` replaces the module for every test file in the run
// (process-global). Preserve every real export (loginKiro, etc. that other
// test files import transitively through the TUI) and only override the
// refresh hook so concurrent-dedup + no-throw behavior can be exercised.
const realKiroCore = await import("pi-kiro/core");
mock.module("pi-kiro/core", () => ({
	...realKiroCore,
	// The hot target. Sleep `refreshDelayMs` so two concurrent callers
	// observe the in-flight promise before it settles. Increment a
	// counter so the test asserts dedup.
	refreshKiroToken: async () => {
		refreshCalls += 1;
		if (refreshDelayMs) {
			await new Promise((r) => setTimeout(r, refreshDelayMs));
		}
		if (refreshShouldThrow) {
			throw new Error("simulated refresh failure");
		}
		return makeFreshCreds(Date.now() + 60_000, `refreshed-${refreshCalls}`);
	},
}));

// Import after mock.module so the provider module resolves `refreshKiroToken`
// through the mocked version.
const { kiroProvider } = await import("../src/backend/providers/kiro");
const { saveKiroCreds, clearKiroCreds } = await import(
	"../src/backend/persistence/auth"
);

function seedExpiredCreds(): void {
	// Drop any prior-test creds from the module-level auth cache, then
	// write fresh expired creds through the regular save path. Going
	// through `saveKiroCreds` (rather than a raw disk write) guarantees
	// the cache reflects what the provider will read next.
	clearKiroCreds();
	saveKiroCreds(makeFreshCreds(Date.now() - 1000, "expired"));
}

describe("kiro refresh", () => {
	beforeEach(() => {
		refreshCalls = 0;
		refreshDelayMs = 0;
		refreshShouldThrow = false;
		// Defensive: drop any creds leaked from a previous test so tests
		// that rely on "signed-out" initial state aren't fragile.
		clearKiroCreds();
	});

	test("concurrent getApiKey calls share one refresh (C1 dedup)", async () => {
		refreshDelayMs = 20;
		seedExpiredCreds();

		const [a, b] = await Promise.all([
			kiroProvider.getApiKey(),
			kiroProvider.getApiKey(),
		]);

		expect(refreshCalls).toBe(1);
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		// Both callers observe the SAME refreshed access token.
		expect(a).toBe(b);
	});

	test("getApiKey returns undefined on refresh failure, does not throw (H1 contract)", async () => {
		refreshShouldThrow = true;
		seedExpiredCreds();

		// Must not reject. pi-agent-core's contract requires a resolved
		// `undefined` or `string`; a rejection propagates to the user as
		// a generic error bubble rather than the intended re-auth toast.
		const key = await kiroProvider.getApiKey();

		expect(key).toBeUndefined();
	});

	test("isConnected returns false after refresh failure clears creds", async () => {
		refreshShouldThrow = true;
		seedExpiredCreds();

		await kiroProvider.getApiKey();

		// clearKiroCreds() was called in the catch branch, so the stored
		// creds are gone and `isConnected()` should report accordingly.
		expect(kiroProvider.isConnected()).toBe(false);
	});

	test("titleModelId resolves when credentials expose the Kiro model list", () => {
		clearKiroCreds();
		saveKiroCreds(makeFreshCreds(Date.now() + 60_000, "connected"));

		const models = kiroProvider.listModels();
		expect(models.some((m) => m.id === kiroProvider.titleModelId)).toBe(true);
	});
});
