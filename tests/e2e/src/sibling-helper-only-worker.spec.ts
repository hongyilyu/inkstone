import { driveEchoRun } from "./driveRun.js";
import { expect, test } from "./fixtures.js";
import { PROVIDER_HELPER_FIXTURE_BIN } from "./spawnCore.js";

/**
 * Regression for the `spawnCore` sibling-mode worker-config gap (PR #178 review):
 * the worker command and the provider-helper sibling are documented as
 * INDEPENDENT, but the original sibling block only configured the worker inside
 * the `else`/no-siblings branch — so `siblingBinaries: { providerHelper }` alone
 * (a worker sibling NOT provided) silently dropped both `opts.workerCmd` and the
 * `GATE_WORKER_CMD` default, leaving the tempdir Core with no worker to spawn.
 *
 * Here we boot Core with ONLY the provider-helper sibling and then drive a chat
 * Run. With the fix, `siblingWorker === undefined` still configures the default
 * GATE worker (the slow-worker fixture via INKSTONE_WORKER_CMD), so the Run
 * streams `echo: hello`. Before the fix, no worker command was set and no worker
 * sibling sat in the tempdir, so Core fell through to the real `tsx cli.ts`
 * worker, which errors without a configured provider — the Run never produces the
 * deterministic echo. The assertion below is therefore RED before the fix.
 */
test.use({
	coreOptions: {
		siblingBinaries: { providerHelper: PROVIDER_HELPER_FIXTURE_BIN },
		// The provider-helper sibling is here to prove worker config, NOT to drive a
		// login — but this spec sends a Run, which the ADR-0062 run-creation gate
		// rejects unless a provider is connected. Seed one explicitly (overrides the
		// sibling-helper's default disconnected start).
		connectedProvider: true,
	},
});

test("provider-helper-only sibling mode still configures the default worker", async ({
	core,
	page,
}) => {
	await page.goto(core.url);

	const result = await driveEchoRun(page, core.url, "hello");

	// Only producible if the default GATE worker (slow-worker fixture) was
	// configured despite no worker sibling being provided.
	expect(result.text).toBe("echo: hello");
	expect(result.done).toBe(true);
});
