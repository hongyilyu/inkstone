import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { logWorkerFault } from "./worker-log.js";

// worker.jsonl sink: the env-gated NDJSON fault trail, sibling to Core's core.jsonl (ADR-0036).

afterEach(() => {
	delete process.env.INKSTONE_WORKER_LOG_PATH;
	delete process.env.INKSTONE_RUN_ID;
});

describe("logWorkerFault", () => {
	it("appends one JSON line with event + run_id from env and the extra fields", () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "inkstone-worker-log-"));
		const logPath = path.join(tmp, "worker.jsonl");
		const runId = "11111111-2222-3333-4444-555555555555";
		process.env.INKSTONE_WORKER_LOG_PATH = logPath;
		process.env.INKSTONE_RUN_ID = runId;

		logWorkerFault("worker.run_error", { message: "boom" });

		const lines = readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toEqual([
			{ event: "worker.run_error", run_id: runId, message: "boom" },
		]);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("is a no-op when INKSTONE_WORKER_LOG_PATH is unset (no file, no throw)", () => {
		const tmp = mkdtempSync(path.join(tmpdir(), "inkstone-worker-log-"));
		const logPath = path.join(tmp, "worker.jsonl");
		// path env deliberately unset.
		process.env.INKSTONE_RUN_ID = "abc";

		expect(() =>
			logWorkerFault("worker.run_error", { message: "boom" }),
		).not.toThrow();
		expect(existsSync(logPath)).toBe(false);
		rmSync(tmp, { recursive: true, force: true });
	});

	it("swallows an fs failure (a path under a nonexistent dir does not throw)", () => {
		process.env.INKSTONE_WORKER_LOG_PATH = path.join(
			tmpdir(),
			"inkstone-no-such-dir-xyz",
			"nested",
			"worker.jsonl",
		);
		process.env.INKSTONE_RUN_ID = "abc";

		expect(() =>
			logWorkerFault("worker.run_error", { message: "boom" }),
		).not.toThrow();
	});
});
