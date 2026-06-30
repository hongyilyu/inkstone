import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { fauxInterpreterDeps } from "../src/faux/faux-deps.js";
import type { InterpreterDeps } from "../src/interpreter.js";
import { runFixture } from "./run.js";
import type { Fixture } from "./types.js";
import { CODEX_ACCESS_TOKEN_ENV } from "./types.js";

// The runner drives the REAL model, so it needs a real provider credential
// (openai-codex OAuth access token, ADR-0023). But the token alone is NOT enough
// to opt in: it's the SAME token real chat uses, so a dev/CI that merely has it set
// would otherwise hit the provider and spend tokens on a bare `pnpm test`. This
// describe is gated behind a SECOND, explicit flag — INKSTONE_EVAL_LIVE=1 — AND the
// token: with either missing, this describe is SKIPPED (a keyless / non-opted-in
// `pnpm -C packages/worker test` / CI stays green by skipping, not failing). The
// scorer tests (`score.test.ts`) run regardless.
const LIVE =
	process.env.INKSTONE_EVAL_LIVE === "1" &&
	!!process.env[CODEX_ACCESS_TOKEN_ENV];
describe.skipIf(!LIVE)("eval runner (real model)", () => {
	it("greets and proposes nothing for a bare hello", async () => {
		const fixture: Fixture = {
			message: "hi there",
			world: [],
			expected: { kind: "none" },
		};
		const predicted = await runFixture(fixture);
		expect(predicted).toBeNull();
	}, 60_000);
});

// UNGATED faux-provider coverage for the runner's capture plumbing — exercises
// `evalTransport` / world-search / the propose-capture branch with NO real key
// by scripting the model through pi-ai's faux provider (mirrors
// `src/interpreter.test.ts`). `runFixture(fixture, deps)` takes optional deps;
// we inject the shared `fauxInterpreterDeps` wiring (faux model + a `Models`
// collection's `streamSimple`).
describe("eval runner (faux provider, keyless)", () => {
	function fauxDeps(): {
		faux: ReturnType<typeof fauxProvider>;
		deps: InterpreterDeps;
	} {
		// The runner pins provider "openai-codex"; build the faux under that name
		// for fidelity, though tests inject `resolveModel` directly so the model
		// comes straight from the faux provider.
		const faux = fauxProvider({ provider: "openai-codex" });
		return { faux, deps: fauxInterpreterDeps(faux) };
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

	it("captures the FIRST of two propose calls in ONE turn (intrinsic first-wins)", async () => {
		// Handler-level first-wins (independent of `terminate` timing): two
		// propose_workspace_mutation calls in a SINGLE assistant message both run
		// their callTool before the loop checks termination. The guarded assignment
		// must keep the FIRST; the cross-turn test above only exercises termination.
		const { faux, deps } = fauxDeps();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("propose_workspace_mutation", {
					mutation_kind: "create_todo",
					payload: { todo: { title: "FIRST" } },
				}),
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
