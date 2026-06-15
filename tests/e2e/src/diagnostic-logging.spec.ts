import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures.js";
import { FAUX_WORKER_CMD } from "./spawnCore.js";

/**
 * Diagnostic Log end-to-end through the real browser UI (ADR-0038, #146).
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
 *   3. The worker line's `run_id` EQUALS the authoritative run_id Core assigned
 *      the Run — captured from the live `/ws` `thread/create` response the client
 *      received. This is the #146 guarantee: run_id now travels in-band on the
 *      WorkerManifest (not the retired `INKSTONE_RUN_ID` env var), so the value
 *      the Worker stamps is provably the SAME id Core minted — the two trails
 *      join on a real key, not merely a non-empty string.
 *
 * This is the browser-driven verification that the per-slice + deep-review passes
 * could not give: it confirms the feature actually produces its artifacts, with a
 * correct join key, when a real user drives a real Run through the real UI.
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
	// Sniff the client's `/ws` frames to capture the AUTHORITATIVE run_id Core
	// assigned — the `thread/create` result the client receives. This is the join
	// key the in-band manifest run_id (#146) must match.
	let authoritativeRunId: string | undefined;
	page.on("websocket", (ws) => {
		ws.on("framereceived", (frame) => {
			if (typeof frame.payload !== "string") return;
			try {
				const msg = JSON.parse(frame.payload) as {
					result?: { run_id?: string };
				};
				const id = msg.result?.run_id;
				if (typeof id === "string" && id.length > 0) {
					authoritativeRunId ??= id;
				}
			} catch {
				// Non-JSON / non-result frame — ignore.
			}
		});
	});

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

	// We must have observed the authoritative run_id over the wire, or the join
	// assertion below is vacuous.
	expect(
		typeof authoritativeRunId === "string" && authoritativeRunId.length > 0,
		"captured the authoritative run_id from the /ws thread/create response",
	).toBe(true);

	// The #146 guarantee: the run_id the Worker stamped — carried IN-BAND on the
	// WorkerManifest, not the retired INKSTONE_RUN_ID env var — is exactly the id
	// Core minted and handed the client. The two trails join on a real key.
	expect(
		runError?.run_id,
		`worker.run_error's run_id must equal Core's authoritative run_id (${authoritativeRunId}) — the in-band manifest join, #146`,
	).toBe(authoritativeRunId);
});
