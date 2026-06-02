import { defineConfig } from "@playwright/test";

/**
 * Full-system harness config (ADR-0019). Unlike `apps/web`'s mock-only smoke
 * (which serves a static `vite preview`), this harness spawns a real Core per
 * test inside the fixtures — so there is NO `webServer` here. `globalSetup`
 * builds Core + the SPA once; each test's fixture spawns Core on an ephemeral
 * port and navigates to its URL.
 */
export default defineConfig({
	testDir: "./src",
	testMatch: /.*\.spec\.ts/,
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: 0,
	// Each test spawns its own Core; cap workers so parallel debug-Core spawns
	// don't thrash a laptop. Override with `--workers` as needed.
	workers: process.env.CI ? 1 : 4,
	reporter: "list",
	globalSetup: "./global-setup.ts",
	timeout: 60_000,
	expect: { timeout: 10_000 },
	use: {
		trace: "on-first-retry",
	},
});
