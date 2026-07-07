import { test as base } from "@playwright/test";
import { ChatPage } from "./page-objects/ChatPage.js";
import {
	type SpawnCoreOptions,
	type SpawnedCore,
	spawnCore,
} from "./spawnCore.js";

/** Full-system Playwright fixtures (ADR-0019): per-test fresh Core + served SPA + `ChatPage`. */
interface HarnessFixtures {
	/** Per-test Core spawn options (gate chunks, etc.). Override via `test.use`. */
	coreOptions: SpawnCoreOptions;
	/** The spawned Core: `{ url, workspaceDir, tripGate, shutdown }`. */
	core: SpawnedCore;
	/** Just the tempdir Workspace path (the DB lives under it). */
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
