import {
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { InterpreterDeps } from "../src/interpreter.js";
import { runFixture } from "./run.js";
import type { Fixture } from "./types.js";
import { CODEX_ACCESS_TOKEN_ENV } from "./types.js";

// The runner drives the REAL model, so it needs a real provider credential
// (openai-codex OAuth access token, ADR-0023). This describe is `skipIf`-gated
// on that token: with no token set, this describe is SKIPPED (a keyless
// `pnpm -C packages/worker test` / CI stays green by skipping, not failing). The
// scorer tests (`score.test.ts`) run regardless.
describe.skipIf(!process.env[CODEX_ACCESS_TOKEN_ENV])(
	"eval runner (real model)",
	() => {
		it("greets and proposes nothing for a bare hello", async () => {
			const fixture: Fixture = {
				message: "hi there",
				world: [],
				expected: { kind: "none" },
			};
			const predicted = await runFixture(fixture);
			expect(predicted).toBeNull();
		}, 60_000);
	},
);

// UNGATED faux-provider coverage for the runner's capture plumbing — exercises
// `evalTransport` / world-search / the propose-capture branch with NO real key
// by scripting the model through pi-ai's faux provider (mirrors
// `src/interpreter.test.ts`). `runFixture(fixture, deps)` takes optional deps;
// we inject `{ resolveModel: () => faux.getModel(), streamFn: streamSimple }`.
describe("eval runner (faux provider, keyless)", () => {
	// Fresh faux provider per test, torn down after, so the pi-ai global
	// api-registry never leaks a provider across tests.
	const registrations: Array<{ unregister: () => void }> = [];
	afterEach(() => {
		for (const r of registrations.splice(0)) r.unregister();
	});

	function fauxDeps(): {
		faux: ReturnType<typeof registerFauxProvider>;
		deps: InterpreterDeps;
	} {
		// The runner pins provider "openai-codex"; register the faux under that name
		// for fidelity, though tests inject `resolveModel` directly so the model
		// comes straight from the faux registration.
		const faux = registerFauxProvider({ provider: "openai-codex" });
		registrations.push(faux);
		const deps: InterpreterDeps = {
			resolveModel: () => faux.getModel(),
			streamFn: streamSimple,
		};
		return { faux, deps };
	}

	it("captures the proposal the model emits via propose_workspace_mutation", async () => {
		const { faux, deps } = fauxDeps();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("propose_workspace_mutation", {
					mutation_kind: "create_todo",
					payload: { todo: { title: "Buy milk" } },
				}),
			]),
		]);

		const fixture: Fixture = {
			message: "Remind me to buy milk",
			world: [],
			expected: { kind: "create_todo" },
		};

		const predicted = await runFixture(fixture, deps);
		expect(predicted).not.toBeNull();
		expect(predicted?.mutation_kind).toBe("create_todo");
		expect(predicted?.payload).toEqual({ todo: { title: "Buy milk" } });
	});

	it("returns null when the model replies with text and proposes nothing", async () => {
		const { faux, deps } = fauxDeps();
		faux.setResponses([fauxAssistantMessage("Hi there — nothing to capture.")]);

		const fixture: Fixture = {
			message: "hi there",
			world: [],
			expected: { kind: "none" },
		};

		const predicted = await runFixture(fixture, deps);
		expect(predicted).toBeNull();
	});

	it("captures the FIRST proposal and ends the turn (does not overwrite)", async () => {
		// A1 regression pin: the propose tool result terminates pi's agent loop, so
		// after the FIRST `propose_workspace_mutation` the model never gets a second
		// turn to propose again. Without `terminate`, the loop would consume the
		// second scripted response and overwrite the capture (silent last-wins).
		const { faux, deps } = fauxDeps();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("propose_workspace_mutation", {
					mutation_kind: "create_todo",
					payload: { todo: { title: "FIRST" } },
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("propose_workspace_mutation", {
					mutation_kind: "create_person",
					payload: { person: { name: "SECOND" } },
				}),
			]),
		]);

		const fixture: Fixture = {
			message: "Remind me to buy milk",
			world: [],
			expected: { kind: "create_todo" },
		};

		const predicted = await runFixture(fixture, deps);
		expect(predicted?.mutation_kind).toBe("create_todo");
		expect(predicted?.payload).toEqual({ todo: { title: "FIRST" } });
		// The second scripted response must NOT have been consumed (loop terminated).
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("searches the world first, then captures the proposal", async () => {
		// search_entities does not terminate; the loop continues to the propose
		// turn, which does. Asserts the world lookup runs without crashing and the
		// proposal is still captured.
		const { faux, deps } = fauxDeps();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("search_entities", {
					type: "project",
					query: "Lead Ads",
				}),
			]),
			fauxAssistantMessage([
				fauxToolCall("propose_workspace_mutation", {
					mutation_kind: "create_todo",
					payload: { todo: { title: "Follow up on Lead Ads" } },
				}),
			]),
		]);

		const fixture: Fixture = {
			message: "Follow up on Lead Ads testing",
			world: [{ type: "project", id: "p1", name: "Lead Ads" }],
			expected: { kind: "create_todo" },
		};

		const predicted = await runFixture(fixture, deps);
		expect(predicted?.mutation_kind).toBe("create_todo");
		expect(predicted?.payload).toEqual({
			todo: { title: "Follow up on Lead Ads" },
		});
	});
});
