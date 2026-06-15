import type { WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { type InterpreterDeps, runInterpreter } from "./interpreter.js";
import { WorkerTransport } from "./transport.js";
import { StdioTransportLive } from "./transport-stdio.js";
import { logWorkerFault } from "./worker-log.js";

/**
 * Shared Worker entry scaffolding both entries call with their own dep-builder — see docs/design/worker.md (ADR-0013, ADR-0018, ADR-0020, ADR-0027).
 * @param buildDeps - Build the interpreter deps for the parsed manifest (real provider deps in prod, env-scripted faux deps in tests).
 */
export function runWorkerMain(
	buildDeps: (manifest: WorkerManifest) => InterpreterDeps,
): void {
	// Read the manifest through the seam, then drive the interpreter. Empty
	// stdin (`readManifest` → null) is a clean exit with no output; Core treats
	// stdout EOF without `done` as a disconnect.
	const program = Effect.gen(function* () {
		const transport = yield* WorkerTransport;
		const manifest = yield* transport.readManifest;
		// Empty stdin (readManifest → null) is a clean exit with no output.
		if (manifest === null) return;
		yield* runInterpreter(manifest, buildDeps(manifest));
	});

	// A Run never ends without a terminal event — see docs/design/worker.md (ADR-0006):
	// a bad manifest or an unexpected throw is converted into a terminal `error` Run Event.
	const main = program.pipe(
		Effect.catchAll((error) =>
			Effect.flatMap(WorkerTransport, (t) =>
				Effect.sync(() => {
					// Diagnostic Log (ADR-0036): additive to the terminal Run Event below.
					logWorkerFault("worker.run_error", { message: error.message });
					t.emit({ kind: "error", message: error.message });
				}),
			),
		),
		Effect.catchAllDefect((defect) =>
			Effect.flatMap(WorkerTransport, (t) =>
				Effect.sync(() => {
					const message =
						defect instanceof Error ? defect.message : String(defect);
					logWorkerFault("worker.run_defect", { message });
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
			logWorkerFault("worker.stdout_failed");
			process.exit(1);
		},
	);
}
