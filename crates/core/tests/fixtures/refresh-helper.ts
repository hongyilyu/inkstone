// Provider Helper STUB for slice-7 tests (refresh mode only). Stands in for
// packages/worker/src/provider.ts so the Core refresh-orchestration test
// never touches real OpenAI. Node builtins only.
//
// Reads one stdin line `{"refresh":"<token>"}`, records this invocation by
// writing a UNIQUE marker file into the directory $INKSTONE_REFRESH_COUNTER
// (so the test counts invocations by counting files — race-free, unlike a
// read-modify-write counter which could lose an update and mask a
// single-flight bug), and emits one Core-shaped credentials line with a
// rotated access token and a far-future expiry. The rotated access token is
// `rotated:<old refresh>` so the test can assert the manifest carried the
// refreshed token.

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

function readFirstLine(): Promise<string | null> {
	return new Promise((resolve) => {
		let buf = "";
		let done = false;
		const finish = (v: string | null): void => {
			if (done) return;
			done = true;
			resolve(v);
		};
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl >= 0) finish(buf.slice(0, nl));
		});
		process.stdin.on("end", () => finish(buf.length > 0 ? buf : null));
		process.stdin.on("error", () => finish(null));
	});
}

async function main(): Promise<void> {
	const line = await readFirstLine();
	if (line === null) {
		process.stdout.write(
			`${JSON.stringify({ kind: "error", message: "no stdin" })}\n`,
		);
		process.exitCode = 1;
		return;
	}
	const { refresh } = JSON.parse(line) as { refresh: string };

	// Record this invocation as a unique file in the marker DIR. Counting
	// files is race-free: two concurrent helpers (which would happen if Core's
	// single-flight lock were removed) each write a DISTINCT file, so the test
	// reliably observes 2 — a non-atomic counter increment could lose an
	// update and falsely report 1, masking the bug. Write the marker BEFORE
	// the latency sleep so overlapping invocations both leave evidence.
	const markerDir = process.env.INKSTONE_REFRESH_COUNTER;
	if (markerDir !== undefined && markerDir.length > 0) {
		mkdirSync(markerDir, { recursive: true });
		writeFileSync(join(markerDir, `${randomUUID()}`), "1");
	}

	// Simulate provider latency so a second concurrent caller would overlap
	// IF Core failed to serialize/double-check — making a single-flight bug
	// observable as two marker files.
	await new Promise((r) => setTimeout(r, 150));

	const rotated = {
		kind: "credentials",
		access: `rotated:${refresh}`,
		refresh: `${refresh}:next`,
		expires: Date.now() + 3_600_000,
		account_id: "acct_stub",
	};
	process.stdout.write(`${JSON.stringify(rotated)}\n`);
}

main().catch((e) => {
	process.stdout.write(
		`${JSON.stringify({ kind: "error", message: String(e) })}\n`,
	);
	process.exit(1);
});
