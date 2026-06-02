import { expect, test } from "@playwright/test";
import { spawnCore } from "./spawnCore.js";

/**
 * Slice 5 RED: the `spawnCore` primitive boots a real Core that serves the
 * real SPA, and shuts down cleanly. No browser yet — this proves only the
 * spawn/serve/teardown primitive the fixtures (slice 6) build on.
 */
test("spawnCore serves the SPA on an ephemeral port and shuts down clean", async () => {
	const core = await spawnCore();

	// Ephemeral port: a real 127.0.0.1 URL, not the fixed 8765 default.
	expect(core.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	expect(core.url).not.toContain(":8765");

	// GET / serves the real built SPA (index.html carries the "Inkstone" title).
	const res = await fetch(core.url);
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain("Inkstone");

	await core.shutdown();

	// After shutdown the listener is gone — a fetch must now fail to connect.
	await expect(fetch(core.url)).rejects.toThrow();
});
