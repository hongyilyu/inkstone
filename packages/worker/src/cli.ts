import { WorkerManifest, type RunEvent } from "@inkstone/protocol";
import {
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import { Schema as S } from "effect";
import {
	type InterpreterDeps,
	defaultInterpreterDeps,
	runInterpreter,
} from "./interpreter.js";

/**
 * The Worker entry point (ADR-0013 stdin transport, ADR-0018 generic
 * interpreter). Reads exactly one NDJSON manifest line from stdin, runs the
 * generic interpreter, and emits Run Events as NDJSON on stdout. There is no
 * per-Workflow code here.
 *
 * Provider deps are chosen by `manifest.workflow.provider`:
 * - `faux` → register pi-ai's faux provider and feed it the canned response
 *   from `INKSTONE_FAUX_RESPONSE` (offline determinism, ADR-0019 as-built).
 * - anything else → {@link defaultInterpreterDeps} (real getModel +
 *   token-injecting streamSimple).
 *
 * Any failure resolving the model or running the loop is converted into a
 * terminal `error` Run Event so a Run never ends without a terminal event
 * (slice-2 review carry #1).
 */

const emit = (event: RunEvent): void => {
	process.stdout.write(`${JSON.stringify(event)}\n`);
};

/** Resolve the first non-empty newline-terminated stdin line (the manifest). */
function readManifestLine(): Promise<string | null> {
	return new Promise((resolve) => {
		let buf = "";
		let done = false;
		const finish = (value: string | null): void => {
			if (done) return;
			done = true;
			resolve(value);
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

/**
 * Build interpreter deps for this manifest. The faux path registers a
 * provider whose single queued response is the env-supplied text (or a
 * faux error when `INKSTONE_FAUX_ERROR` is set), so Core integration tests
 * drive the real interpreter offline.
 */
function depsFor(manifest: WorkerManifest): InterpreterDeps {
	if (manifest.workflow.provider !== "faux") {
		return defaultInterpreterDeps();
	}
	const faux = registerFauxProvider({ provider: "faux" });
	const errorMessage = process.env.INKSTONE_FAUX_ERROR;
	if (errorMessage !== undefined && errorMessage.length > 0) {
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		]);
	} else if (process.env.INKSTONE_FAUX_ECHO_HISTORY === "1") {
		// History-echo mode (multi-turn test): reply with the prior messages
		// the loop passed in its context — both roles — so the test can prove
		// Core assembled BOTH the prior user prompt AND the prior assistant
		// reply into the manifest history (the assistant turn is the
		// slice-9 race that this exercises). Uses a response factory so it
		// reads the live context rather than a canned string.
		const textOf = (content: unknown): string => {
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				return content
					.map((c) =>
						c && typeof c === "object" && "text" in c
							? String((c as { text: unknown }).text)
							: "",
					)
					.join("");
			}
			return "";
		};
		faux.setResponses([
			(context) => {
				// All prior turns except the current prompt (the last user
				// message). Tag each with its role so the test can assert the
				// assistant turn specifically.
				const prior = context.messages.slice(0, -1);
				const parts = prior.map(
					(m) => `${m.role}=${textOf(m.content)}`,
				);
				return fauxAssistantMessage(`history:${parts.join("|")}`);
			},
		]);
	} else {
		faux.setResponses([
			fauxAssistantMessage(process.env.INKSTONE_FAUX_RESPONSE ?? "faux reply"),
		]);
	}
	return {
		resolveModel: () => faux.getModel(),
		streamFn: streamSimple,
	};
}

async function main(): Promise<void> {
	const line = await readManifestLine();
	if (line === null) {
		// Empty stdin — nothing to run. Mirror the prior worker's exit-0 on
		// no input; Core treats stdout EOF without `done` as a disconnect.
		return;
	}

	let manifest: WorkerManifest;
	try {
		manifest = S.decodeUnknownSync(WorkerManifest)(JSON.parse(line));
	} catch (e) {
		emit({
			kind: "error",
			message: `worker could not parse manifest: ${
				e instanceof Error ? e.message : String(e)
			}`,
		});
		return;
	}

	try {
		await runInterpreter(manifest, emit, depsFor(manifest));
	} catch (e) {
		// runInterpreter normally emits its own terminal event, but an
		// unexpected throw (unknown provider in getModel, loop defect) must
		// still terminate the Run with an error rather than a silent EOF.
		emit({
			kind: "error",
			message: e instanceof Error ? e.message : String(e),
		});
	}
}

main().then(
	() => process.exit(0),
	(e) => {
		// Last-resort guard: emit a terminal error before exiting non-zero.
		try {
			emit({
				kind: "error",
				message: e instanceof Error ? e.message : String(e),
			});
		} catch {
			// stdout already closed; nothing more to do.
		}
		process.exit(1);
	},
);
