import type { WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { type InterpreterDeps, runInterpreter } from "./interpreter.js";
import { StdioTransportLive } from "./transport-stdio.js";
import { WorkerTransport } from "./transport.js";

/**
 * The shared Worker entry scaffolding (ADR-0013 stdin transport, ADR-0018
 * generic interpreter, ADR-0027 transport seam). Both the production entry
 * (`cli.ts`) and the test-only faux entry (`faux-worker.ts`) call this with
 * their own dep-builder; the only difference between the two entries is which
 * {@link InterpreterDeps} they inject. There is no per-Workflow code here.
 *
 * `main` is an `Effect.gen` from entry to exit (ADR-0020): it reads the
 * manifest through {@link WorkerTransport}, runs the generic interpreter against
 * the stdio transport, and lets the interpreter emit Run Events as NDJSON. The
 * stdio plumbing — readline, the `tool_call_id` correlation map, the stdout
 * writer — lives behind the seam in {@link StdioTransportLive}.
 *
 * This module has NO top-level side effect: `runWorkerMain` does the running
 * only when an entry calls it, so the entries (and their tests) can import the
 * scaffolding without booting a Worker.
 *
 * @param buildDeps - Build the interpreter deps for the parsed manifest. The
 *   production entry returns real provider deps; the faux entry returns
 *   env-scripted faux deps.
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
		if (manifest === null) return;
		// The interpreter sources both transport channels (`emit` + `callTool`)
		// from the provided seam (ADR-0027); only provider deps are injected.
		yield* runInterpreter(manifest, buildDeps(manifest));
	});

	// A Run never ends without a terminal event: a bad manifest (typed
	// ManifestParseError) or an unexpected throw (unknown provider in getModel,
	// a loop defect) is converted into a terminal `error` Run Event through the
	// seam (ADR-0006).
	const main = program.pipe(
		Effect.catchAll((error) =>
			Effect.flatMap(WorkerTransport, (t) =>
				Effect.sync(() => t.emit({ kind: "error", message: error.message })),
			),
		),
		Effect.catchAllDefect((defect) =>
			Effect.flatMap(WorkerTransport, (t) =>
				Effect.sync(() =>
					t.emit({
						kind: "error",
						message: defect instanceof Error ? defect.message : String(defect),
					}),
				),
			),
		),
		Effect.provide(StdioTransportLive),
	);

	Effect.runPromise(main).then(
		() => process.exit(0),
		// Last resort: the seam already emits the terminal error for every
		// non-catastrophic path above, so a rejection here means stdout itself
		// failed — nothing left to do but exit non-zero.
		() => process.exit(1),
	);
}
