import type { RunEvent } from "@inkstone/protocol";
import { Layer } from "effect";
import { WorkerTransport } from "./transport.js";

/**
 * Test `Layer` for {@link WorkerTransport} (ADR-0027): `emit` pushes each Run
 * Event into the caller's `captured` array, which the test asserts on after
 * running the interpreter. No process, no readline, no stdout capture.
 *
 * Later slices grow this with a scripted tool-result table (for `callTool`)
 * and a preset manifest (for `readManifest`).
 */
export const InMemoryTransport = (
	captured: RunEvent[],
): Layer.Layer<WorkerTransport> =>
	Layer.succeed(WorkerTransport, {
		emit: (event) => {
			captured.push(event);
		},
	});
