import { createInterface } from "node:readline";
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
			// readline emits a final partial line before "close", so the
			// no-trailing-newline case resolves with that line; empty input closes
			// without a "line" event and resolves null. Promise settle-once makes
			// the line→close double-resolve a no-op.
			const rl = createInterface({ input: process.stdin });
			rl.once("line", (line) => resolve(line));
			rl.once("close", () => resolve(null));
			rl.once("error", () => resolve(null));
		}),
};

runHelperMain(
	process.argv.slice(2),
	{ login: loginOpenAICodex, refresh: refreshOpenAICodexToken },
	io,
)
	.then((code) => {
		process.exitCode = code;
	})
	// runHelperMain resolves with a code on every dispatch path; the only way
	// here is io.emit itself throwing (e.g. EPIPE on a closed stdout). Nothing
	// left to write — just exit nonzero instead of an unhandled rejection.
	.catch(() => {
		process.exitCode = 1;
	});
