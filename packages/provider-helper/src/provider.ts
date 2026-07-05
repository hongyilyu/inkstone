import {
	loginOpenAICodex,
	refreshOpenAICodexToken,
} from "@earendil-works/pi-ai/oauth";
import { type HelperIo, runHelperMain } from "./helper-main.js";

// Provider Helper: stateless OAuth process Core spawns (refresh/login modes) — see docs/design/worker.md (ADR-0023)
// Thin entry: the mode/provider dispatch, mapping, and redaction live in
// helper-main.ts behind the injected-deps seam.

const io: HelperIo = {
	emit: (line) => {
		process.stdout.write(`${JSON.stringify(line)}\n`);
	},
	readFirstLine: () =>
		new Promise((resolve) => {
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
		}),
};

runHelperMain(
	process.argv.slice(2),
	{ login: loginOpenAICodex, refresh: refreshOpenAICodexToken },
	io,
).then((code) => {
	process.exitCode = code;
});
