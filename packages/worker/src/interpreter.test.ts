import {
	fauxAssistantMessage,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import type { WorkerManifest } from "@inkstone/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Emit, type InterpreterDeps, runInterpreter } from "./interpreter.js";

// Each test registers a fresh faux provider and tears it down after, so the
// pi-ai global api-registry never leaks a provider across tests.
const registrations: Array<{ unregister: () => void }> = [];
afterEach(() => {
	for (const r of registrations.splice(0)) r.unregister();
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

function collect(): { emit: Emit; events: import("@inkstone/protocol").RunEvent[] } {
	const events: import("@inkstone/protocol").RunEvent[] = [];
	return { emit: (e) => events.push(e), events };
}

describe("generic interpreter (faux provider)", () => {
	it("streams a faux completion as text deltas then done", async () => {
		const faux = registerFauxProvider({ provider: "faux", tokenSize: { min: 1, max: 2 } });
		registrations.push(faux);
		faux.setResponses([fauxAssistantMessage("hello world")]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

		const { emit, events } = collect();
		await runInterpreter(fauxManifest(), emit, deps);

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "done" });

		const text = events
			.filter((e): e is { kind: "text_delta"; delta: string } => e.kind === "text_delta")
			.map((e) => e.delta)
			.join("");
		expect(text).toBe("hello world");

		// No error event on the happy path.
		expect(events.some((e) => e.kind === "error")).toBe(false);
	});

	it("surfaces a faux error as the error event, not done", async () => {
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "provider exploded",
			}),
		]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

		const { emit, events } = collect();
		await runInterpreter(fauxManifest(), emit, deps);

		const terminal = events[events.length - 1];
		expect(terminal).toEqual({ kind: "error", message: "provider exploded" });
		expect(events.some((e) => e.kind === "done")).toBe(false);
	});

	it("passes prior history into the loop context", async () => {
		// The faux response factory can inspect the context it received,
		// proving the manifest's assembled history reached the provider.
		const faux = registerFauxProvider({ provider: "faux" });
		registrations.push(faux);
		let seenUserTexts: string[] = [];
		faux.setResponses([
			(context) => {
				seenUserTexts = context.messages
					.filter((m) => m.role === "user")
					.map((m) =>
						typeof m.content === "string"
							? m.content
							: m.content.map((c) => ("text" in c ? c.text : "")).join(""),
					);
				return fauxAssistantMessage("ack");
			},
		]);

		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};

		const manifest = fauxManifest({
			prompt: "current question",
			messages: [
				{ role: "user", text: "earlier question" },
				{ role: "assistant", text: "earlier answer" },
			],
		});

		const { emit } = collect();
		await runInterpreter(manifest, emit, deps);

		expect(seenUserTexts).toContain("earlier question");
		expect(seenUserTexts).toContain("current question");
	});
});
