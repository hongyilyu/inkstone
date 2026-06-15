import type { WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { type InterpreterDeps, runInterpreter } from "./interpreter.js";
import { ManifestParseError, WorkerTransport } from "./transport.js";
import { StdioTransportLive } from "./transport-stdio.js";
import { logWorkerFault } from "./worker-log.js";

/**
 * Shared Worker entry scaffolding both entries call with their own dep-builder — see docs/design/worker.md (ADR-0013, ADR-0018, ADR-0020, ADR-0027).
 * @param buildDeps - Build the interpreter deps for the parsed manifest (real provider deps in prod, env-scripted faux deps in tests).
 */
export function runWorkerMain(
	buildDeps: (manifest: WorkerManifest) => InterpreterDeps,
): void {
	// Captured from the manifest once it parses, so the catchAll/catchAllDefect
	// closures below (which wrap the manifest read and have no manifest in scope)
	// can stamp the Run's run_id. On a manifest-parse failure it stays "", but the
	// catchAll prefers the run_id salvaged onto ManifestParseError when the line
	// parsed as JSON yet failed schema validation (#146), so a mirror-skew failure
	// still logs a joinable run_id; only a JSON syntax error leaves it "".
	let runId = "";

	// Read the manifest through the seam, then drive the interpreter. Empty
	// stdin (`readManifest` → null) is a clean exit with no output; Core treats
	// stdout EOF without `done` as a disconnect.
	const program = Effect.gen(function* () {
		const transport = yield* WorkerTransport;
		const manifest = yield* transport.readManifest;
		// Empty stdin (readManifest → null) is a clean exit with no output.
		if (manifest === null) return;
		runId = manifest.run_id;
		yield* runInterpreter(manifest, buildDeps(manifest));
	});

	// A Run never ends without a terminal event — see docs/design/worker.md (ADR-0006):
	// a bad manifest or an unexpected throw is converted into a terminal `error` Run Event.
	const main = program.pipe(
		Effect.catchAll((error) =>
			Effect.flatMap(WorkerTransport, (t) =>
				Effect.sync(() => {
					// Diagnostic Log (ADR-0038): additive to the terminal Run Event below.
					// `source` distinguishes this program-level catchAll from the
					// interpreter's model-reported `worker.run_error` (same key, so an
					// agent's `GROUP BY event` mines all run errors together). Prefer the
					// run_id salvaged off a schema-skew ManifestParseError (#146) over the
					// "" default, so that failure still joins to core.jsonl by run.
					const faultRunId =
						error instanceof ManifestParseError && error.runId !== undefined
							? error.runId
							: runId;
					logWorkerFault("worker.run_error", faultRunId, {
						source: "catch_all",
						message: error.message,
					});
					t.emit({ kind: "error", message: error.message });
				}),
			),
		),
		Effect.catchAllDefect((defect) =>
			Effect.flatMap(WorkerTransport, (t) =>
				Effect.sync(() => {
					const message =
						defect instanceof Error ? defect.message : String(defect);
					logWorkerFault("worker.run_defect", runId, { message });
					t.emit({ kind: "error", message });
				}),
			),
		),
		Effect.provide(StdioTransportLive),
	);

	Effect.runPromise(main).then(
		() => process.exit(0),
		// A rejection here means stdout itself failed — nothing left to do but exit non-zero.
		() => {
			logWorkerFault("worker.stdout_failed", runId);
			process.exit(1);
		},
	);
}
