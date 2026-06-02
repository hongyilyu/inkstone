import { test as base } from "@playwright/test";
import { type SpawnCoreOptions, type SpawnedCore, spawnCore } from "./spawnCore.js";
import { ChatPage } from "./page-objects/ChatPage.js";

/**
 * Full-system fixtures (ADR-0019). Each test gets a fresh Core (own tempdir
 * Workspace, ephemeral port) serving the real built SPA, plus a `ChatPage`
 * page-object bound to Playwright's `page`. Teardown shuts Core down and
 * removes the tempdir.
 *
 * Per-test Core config is set by tagging the test with `test.use({ coreOptions })`
 * — e.g. the acceptance specs request a gated 2-chunk fixture so they can pause
 * a Run mid-stream. The default (no options) is the fast, ungated echo path.
 */
interface HarnessFixtures {
	/** Per-test Core spawn options (gate chunks, etc.). Override via `test.use`. */
	coreOptions: SpawnCoreOptions;
	/** The spawned Core: `{ url, workspaceDir, tripGate, shutdown }`. */
	core: SpawnedCore;
	/** Just the tempdir Workspace path (Vault/DB live under it). */
	workspace: { readonly path: string };
	/** Page-object over the rendered chat surface, pre-navigated to `core.url`. */
	chat: ChatPage;
}

export const test = base.extend<HarnessFixtures>({
	coreOptions: [{}, { option: true }],

	core: async ({ coreOptions }, use) => {
		const core = await spawnCore(coreOptions);
		await use(core);
		await core.shutdown();
	},

	workspace: async ({ core }, use) => {
		await use({ path: core.workspaceDir });
	},

	chat: async ({ core, page }, use) => {
		const chat = new ChatPage(page, core.url);
		await use(chat);
	},
});

export { expect } from "@playwright/test";
