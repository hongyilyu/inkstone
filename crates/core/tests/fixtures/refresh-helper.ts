// Provider Helper STUB for slice-7 tests (refresh mode only). Stands in for
// packages/worker/src/provider.ts so the Core refresh-orchestration test
// never touches real OpenAI. Node builtins only.
//
// Reads one stdin line `{"refresh":"<token>"}`, increments a counter file at
// $INKSTONE_REFRESH_COUNTER (so the test can assert single-flight), and emits
// one Core-shaped credentials line with a rotated access token and a
// far-future expiry. The rotated access token is `rotated:<old refresh>` so
// the test can assert the manifest carried the refreshed token.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

	// Bump the invocation counter (single-flight assertion). A tiny
	// read-modify-write; the refresh lock on the Core side serializes callers,
	// so there's no concurrent write here in the single-flight case.
	const counterPath = process.env.INKSTONE_REFRESH_COUNTER;
	if (counterPath !== undefined && counterPath.length > 0) {
		const prev =
			existsSync(counterPath) && readFileSync(counterPath, "utf8").trim() !== ""
				? Number.parseInt(readFileSync(counterPath, "utf8").trim(), 10)
				: 0;
		writeFileSync(counterPath, String(prev + 1));
	}

	// Simulate provider latency so a second concurrent caller would overlap
	// IF Core failed to serialize/double-check — making a single-flight bug
	// observable as counter > 1.
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
