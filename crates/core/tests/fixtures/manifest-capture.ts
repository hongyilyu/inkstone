// Worker STUB (ADR-0024 slice 3): a manifest-capture worker. Stands in for the
// real interpreter via INKSTONE_WORKER_CMD so a Core test can OBSERVE the
// resolved `model` + `thinking_level` Core shipped in the WorkerManifest —
// proving user settings (preferred model + global effort) flow into the Run.
// Node builtins only.
//
// Reads one stdin line (the WorkerManifest), emits "model=<m>|effort=<e>" as a
// single text_delta (Core persists it to the assistant message), then done.

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
	const manifest = JSON.parse(line) as {
		workflow?: { model?: string; thinking_level?: string };
	};
	const model = manifest.workflow?.model ?? "<none>";
	const effort = manifest.workflow?.thinking_level ?? "<none>";
	emit({ kind: "text_delta", delta: `model=${model}|effort=${effort}` });
	emit({ kind: "done" });
}

main().catch((e) => {
	emit({ kind: "error", message: String(e) });
	process.exit(1);
});
