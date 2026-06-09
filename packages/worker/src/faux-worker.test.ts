import type { RunEvent, WorkerManifest } from "@inkstone/protocol";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { fauxDepsFor } from "./faux-worker.js";
import { runInterpreter } from "./interpreter.js";
import { InMemoryTransport } from "./transport-memory.js";

// `fauxDepsFor` reads the `INKSTONE_FAUX_*` env vars at call time (it is the
// test-only entry's dep-builder; reading them is legitimate test code). Clear
// them after each case so one mode never bleeds into the next.
const FAUX_ENV_KEYS = [
	"INKSTONE_FAUX_RESPONSE",
	"INKSTONE_FAUX_ERROR",
	"INKSTONE_FAUX_TOOL_CALL",
	"INKSTONE_FAUX_PROPOSE",
	"INKSTONE_FAUX_ECHO_HISTORY",
] as const;
afterEach(() => {
	for (const key of FAUX_ENV_KEYS) delete process.env[key];
});

function fauxManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
	return {
		workflow: {
			name: "default",
			version: "1.0.0",
			provider: "faux",
			model: "faux-1",
			system_prompt: "You are a test assistant.",
			thinking_level: "off",
			tools: [],
		},
		prompt: "hello",
		messages: [],
		...overrides,
	};
}

// Drive the interpreter with the deps the faux entry builds, through an
// InMemoryTransport (ADR-0027), and return the Run Events the seam captured.
// `fauxDepsFor` owns the faux-provider registration internally; each call
// registers a fresh provider keyed by a unique random `api`, so cases don't
// contaminate one another.
function runChat(manifest: WorkerManifest): Promise<RunEvent[]> {
	const captured: RunEvent[] = [];
	return Effect.runPromise(
		runInterpreter(manifest, fauxDepsFor(manifest)).pipe(
			Effect.provide(InMemoryTransport(captured)),
		),
	).then(() => captured);
}

describe("faux-worker dep-builder (test-only entry)", () => {
	it("scripts the faux provider from INKSTONE_FAUX_RESPONSE: text_delta then done", async () => {
		process.env.INKSTONE_FAUX_RESPONSE = "scripted faux reply";

		const events = await runChat(fauxManifest());

		// The dep-builder seeded the faux provider with the env text; the
		// interpreter streams it as one or more `text_delta` chunks (faux/
		// streamSimple chunk boundaries are not fixed) then a terminal `done`.
		// Reassemble the deltas (as faux_run.rs does) rather than asserting a
		// single delta — the latter is chunk-order-dependent and flaky.
		const text = events
			.filter((e) => e.kind === "text_delta")
			.map((e) => (e as { delta: string }).delta)
			.join("");
		expect(text).toBe("scripted faux reply");
		expect(events.at(-1)).toEqual({ kind: "done" });
	});

	it("scripts a faux error from INKSTONE_FAUX_ERROR: terminal error, not done", async () => {
		process.env.INKSTONE_FAUX_ERROR = "scripted boom";

		const events = await runChat(fauxManifest());

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "error", message: "scripted boom" });
		expect(events.some((e) => e.kind === "done")).toBe(false);
	});
});
