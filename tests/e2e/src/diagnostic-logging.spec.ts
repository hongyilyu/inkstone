import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Diagnostic Log end-to-end through the real browser UI (ADR-0038).
 *
 * Boots the full system — real Core (serving the SPA), the faux-interpreter
 * Worker, a Chromium browser — and drives a Run from the chat surface the way a
 * user would. The faux provider is scripted to FAIL the turn, so the Worker
 * surfaces a terminal `error` Run Event AND writes a `worker.run_error` line to
 * its `worker.jsonl` sink. The test then reads both diagnostic files off disk
 * and asserts:
 *   1. Core wrote `core.jsonl` with a structured `event` (the subscriber works).
 *   2. The Worker wrote `worker.jsonl` BY DEFAULT (Core supplied the path) with a
 *      `worker.run_error` event — the worker half of the trail is live, not inert.
 *   3. The worker line carries a non-empty `run_id` (the env seam works), so the
 *      two files are joinable — the whole point of the feature.
 *
 * This is the browser-driven verification that the per-slice + deep-review passes
 * could not give: it confirms the feature actually produces its artifacts when a
 * real user drives a real Run through the real UI.
 */
test.use({
	coreOptions: {
		workerCmd: FAUX_WORKER_CMD,
		fauxError: "verification: forced turn failure",
	},
});

/** Read every non-empty JSONL line of every file under `dir` (daily appender
 * date-suffixes the filename, so the exact name is not assumed). */
function readJsonlLines(dir: string): Record<string, unknown>[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: Record<string, unknown>[] = [];
	for (const name of entries) {
		const body = readFileSync(path.join(dir, name), "utf8");
		for (const line of body.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				out.push(JSON.parse(line) as Record<string, unknown>);
			} catch {
				// non-JSON line (shouldn't happen for the JSONL trail) — skip.
			}
		}
	}
	return out;
}

test("a Run driven from the browser writes correlated core.jsonl + worker.jsonl", async ({
	chat,
	core,
	page,
}) => {
	// Drive a real Run through the rendered chat UI, like a user.
	await chat.goto();
	await chat.send("trigger a failing run");

	// The faux error surfaces as an error on the assistant turn in the UI —
	// confirming the Run actually executed end-to-end through the browser.
	const error = page.getByTestId("assistant-error");
	await expect(error).toBeVisible({ timeout: 15_000 });
	await expect(error).toContainText("verification: forced turn failure");

	// Give the Worker's synchronous appendFileSync a beat to land before reading.
	await page.waitForTimeout(250);

	// Core's trail: core.jsonl lives directly in the log dir.
	const coreLines = readJsonlLines(core.logDir);
	expect(
		coreLines.length,
		"Core wrote at least one structured JSONL event to core.jsonl",
	).toBeGreaterThan(0);
	expect(
		coreLines.some((l) => typeof l.event === "string"),
		"core.jsonl events carry a stable `event` key",
	).toBe(true);

	// The Worker's sibling trail: worker.jsonl, written BY DEFAULT (Core supplied
	// INKSTONE_WORKER_LOG_PATH = <logDir>/worker.jsonl). It is a single appended
	// file, not date-rolled, so read it directly.
	const workerBody = readFileSync(
		path.join(core.logDir, "worker.jsonl"),
		"utf8",
	);
	const workerLines = workerBody
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);

	const runError = workerLines.find((l) => l.event === "worker.run_error");
	expect(
		runError,
		"the Worker wrote a worker.run_error event to worker.jsonl (the worker trail is live by default, not inert)",
	).toBeDefined();

	// The correlation key: a non-empty run_id stamped from INKSTONE_RUN_ID, so
	// worker.jsonl joins to core.jsonl by run.
	const runId = runError?.run_id;
	expect(
		typeof runId === "string" && runId.length > 0,
		`worker.run_error carries a non-empty run_id for the core.jsonl join — got ${JSON.stringify(runId)}`,
	).toBe(true);
});
