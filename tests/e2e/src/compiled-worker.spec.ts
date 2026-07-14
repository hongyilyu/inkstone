import { driveEchoRun } from "./driveRun.js";
import { expect, test } from "./fixtures.js";
import { WORKER_FIXTURE_BIN } from "./spawnCore.js";

/**
 * Compiled Worker, auto-detected end-to-end (ADR-0041, slice 3).
 *
 * Core is booted from an isolated tempdir with a compiled `inkstone-worker`
 * binary sitting NEXT TO its own executable and NO `INKSTONE_WORKER_CMD` set —
 * so the only way a Run can produce the fixture's `echo: <prompt>` output is
 * Core's ADR-0041 step-2 sibling auto-detection firing on `current_exe`'s
 * directory, spawning the sibling, and streaming its NDJSON back. The fixture
 * (the bun-compiled slow-worker) is deterministic and offline, so this proves
 * detection -> spawn -> stdio -> stream without a live provider.
 *
 * `global-setup.ts` compiles the fixture to a NON-real name; `spawnCore`'s
 * `siblingBinaries.worker` mode copies it to the real `inkstone-worker` name
 * inside the per-test tempdir (never `target/debug/inkstone-worker`, which
 * would hijack `pnpm dev` + other specs).
 */
test.use({ coreOptions: { siblingBinaries: { worker: WORKER_FIXTURE_BIN } } });

test("Core auto-detects + spawns a sibling worker binary and streams a Run", async ({
	core,
	page,
}) => {
	await page.goto(core.url);

	const result = await driveEchoRun(page, core.url, "hello");

	// The reassembled stream is the fixture's `echo: <prompt>` — only producible
	// if Core auto-detected the sibling binary and drove it to completion.
	expect(result.text).toBe("echo: hello");
	expect(result.done).toBe(true);
});
