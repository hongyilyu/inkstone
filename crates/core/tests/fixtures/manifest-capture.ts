// Worker STUB (ADR-0024 slice 3): a manifest-capture worker. Stands in for the
// real interpreter via INKSTONE_WORKER_CMD so a Core test can OBSERVE the
// resolved `model` + `thinking_level` Core shipped in the WorkerManifest —
// proving user settings (preferred model + global effort) flow into the Run —
// and (chat-image-attachments slice 3) the forwarded `attachments` array.
// Node builtins only; the manifest line is raw-JSON.parse'd, no schema dep.
//
// Reads one stdin line (the WorkerManifest), emits
// "model=<m>|effort=<e>|provider=<p>|attachments=<n>" — plus, when attachments
// are present, "|amime=<first mime>|adata=<first 12 base64 chars>" so a test
// can assert real bytes flowed — as a single text_delta (Core persists it to
// the assistant message), then done.
//
// INKSTONE_FIXTURE_FAIL_ONCE (run-retry tests): a filesystem path. When set
// and the file does NOT exist yet, the fixture creates it and terminates with
// an `error` event instead of echoing — the NEXT spawn sees the marker and
// echoes normally, so a test can drive errored → run/retry deterministically.

import { existsSync, writeFileSync } from "node:fs";

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
	const failOnce = process.env.INKSTONE_FIXTURE_FAIL_ONCE;
	if (failOnce !== undefined && failOnce.length > 0 && !existsSync(failOnce)) {
		writeFileSync(failOnce, "");
		emit({ kind: "error", message: "fail once" });
		return;
	}
	const manifest = JSON.parse(line) as {
		workflow?: { model?: string; thinking_level?: string; provider?: string };
		attachments?: Array<{ mime?: string; data_base64?: string }>;
	};
	const model = manifest.workflow?.model ?? "<none>";
	const effort = manifest.workflow?.thinking_level ?? "<none>";
	const provider = manifest.workflow?.provider ?? "<none>";
	let delta = `model=${model}|effort=${effort}|provider=${provider}|attachments=${manifest.attachments?.length ?? 0}`;
	const first = manifest.attachments?.[0];
	if (first !== undefined) {
		delta += `|amime=${first.mime ?? "<none>"}|adata=${(first.data_base64 ?? "").slice(0, 12)}`;
	}
	emit({ kind: "text_delta", delta });
	emit({ kind: "done" });
}

main().catch((e) => {
	emit({ kind: "error", message: String(e) });
	process.exit(1);
});
