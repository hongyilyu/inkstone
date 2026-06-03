// Worker STUB for slice-7 tests: a manifest-echo worker. Stands in for the
// real interpreter (packages/worker/src/cli.ts) via INKSTONE_WORKER_CMD so a
// Core refresh test can OBSERVE the access_token Core injected into the
// manifest without a real provider. Node builtins only.
//
// Reads one stdin line (the WorkerManifest), emits the access_token as a
// single text_delta (or "<none>" when absent), then done.

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

const emit = (event: unknown): void => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
};

async function main(): Promise<void> {
	const line = await readFirstLine();
	if (line === null) return;
	const manifest = JSON.parse(line) as { access_token?: string };
	const token = manifest.access_token ?? "<none>";
	emit({ kind: "text_delta", delta: token });
	emit({ kind: "done" });
}

main().catch((e) => {
	emit({ kind: "error", message: String(e) });
	process.exit(1);
});
