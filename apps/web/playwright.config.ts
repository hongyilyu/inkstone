import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:4178",
		trace: "on-first-retry",
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
	],
	webServer: {
		command: "pnpm preview --port 4178 --strictPort --host 127.0.0.1",
		url: "http://127.0.0.1:4178",
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
	},
});
