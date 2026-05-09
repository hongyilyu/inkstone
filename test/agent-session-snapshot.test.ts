/**
 * Backend `Session.subscribe()` contract tests.
 *
 * The TUI integration (provider + actions) is covered by reducer tests
 * that go through `fake-session.ts`. Those tests do NOT exercise the real
 * `createSession` in `src/backend/agent/index.ts` — so a regression where
 * someone removes a `notify()` call from `setModel` / `setThinkingLevel`
 * / `clearAgentModel` / `clearAgentThinkingLevel` / `selectAgent`
 * wouldn't surface in TUI tests (the fake has its own setters that call
 * its own `notify()`).
 *
 * This file plugs that gap: build a real `Session`, register a subscriber,
 * exercise each mutation verb, assert the subscriber observed the
 * corresponding snapshot transition. No network — `setModel` etc. only
 * mutate local state and write `config.json`, both of which the test
 * preload already isolates per-process.
 */

import { describe, expect, test } from "bun:test";
import { createSession } from "@backend/agent";
import { openrouterProvider } from "@backend/providers/openrouter";
import type { SessionSnapshot } from "@bridge/view-model";

import "./preload";

function buildSession() {
	const session = createSession({
		agentName: "reader",
		onEvent: () => {
			// no-op; not exercising pi-agent-core stream events here
		},
	});
	const captured: SessionSnapshot[] = [];
	const unsubscribe = session.subscribe((snap) => {
		captured.push(snap);
	});
	return { session, captured, unsubscribe };
}

describe("Session.subscribe — mutation fan-out", () => {
	test("setModel emits a snapshot reflecting the new model", () => {
		const { session, captured, unsubscribe } = buildSession();
		try {
			// Pick a different OpenRouter model than the default so the
			// snapshot diff is non-trivial.
			const models = openrouterProvider.listModels();
			const initial = session.snapshot();
			const target = models.find((m) => m.name !== initial.modelName);
			if (!target) throw new Error("preload didn't seed enough models");

			session.actions.setModel(target);

			expect(captured).toHaveLength(1);
			expect(captured[0]?.modelName).toBe(target.name);
			expect(captured[0]?.modelProvider).toBe(target.provider);
			expect(captured[0]?.contextWindow).toBe(target.contextWindow);
			expect(captured[0]?.modelReasoning).toBe(target.reasoning);
			// `selectAgent`-derived fields ride along unchanged.
			expect(captured[0]?.agentName).toBe(initial.agentName);
		} finally {
			unsubscribe();
		}
	});

	test("setThinkingLevel emits a snapshot with the new level", () => {
		const { session, captured, unsubscribe } = buildSession();
		try {
			// Need a reasoning model for thinkingLevel to mean anything;
			// pick one if available, otherwise still verify the emission.
			const models = openrouterProvider.listModels();
			const reasoning = models.find((m) => m.reasoning);
			if (reasoning) session.actions.setModel(reasoning);
			const before = captured.length;

			session.actions.setThinkingLevel("low");

			expect(captured.length).toBe(before + 1);
			expect(captured[captured.length - 1]?.thinkingLevel).toBe("low");
		} finally {
			unsubscribe();
		}
	});

	test("clearAgentModel emits a snapshot after re-resolving", () => {
		const { session, captured, unsubscribe } = buildSession();
		try {
			const models = openrouterProvider.listModels();
			const target = models.find((m) => m.id !== session.snapshot().modelName);
			if (!target) throw new Error("preload didn't seed enough models");
			session.actions.setModel(target);
			const beforeClear = captured.length;

			session.actions.clearAgentModel();

			// One additional emission for the clear; snapshot reflects the
			// re-resolved model (top-level → provider default — preload has
			// no top-level `model` field, so falls through to OpenRouter
			// default).
			expect(captured.length).toBe(beforeClear + 1);
			const last = captured[captured.length - 1]!;
			expect(last.modelProvider).toBe("openrouter");
		} finally {
			unsubscribe();
		}
	});

	test("clearAgentThinkingLevel emits a snapshot", () => {
		const { session, captured, unsubscribe } = buildSession();
		try {
			const models = openrouterProvider.listModels();
			const reasoning = models.find((m) => m.reasoning);
			if (reasoning) session.actions.setModel(reasoning);
			session.actions.setThinkingLevel("medium");
			const before = captured.length;

			session.actions.clearAgentThinkingLevel();

			expect(captured.length).toBe(before + 1);
			// After clearing the agent override, the level resolves through
			// the top-level fallback chain to "off".
			expect(captured[captured.length - 1]?.thinkingLevel).toBe("off");
		} finally {
			unsubscribe();
		}
	});

	test("selectAgent emits a snapshot with the new agent name", () => {
		const { session, captured, unsubscribe } = buildSession();
		try {
			session.selectAgent("knowledge-base");

			expect(captured.length).toBeGreaterThanOrEqual(1);
			expect(captured[captured.length - 1]?.agentName).toBe("knowledge-base");
		} finally {
			unsubscribe();
		}
	});

	test("unsubscribe stops further emissions", () => {
		const { session, captured, unsubscribe } = buildSession();
		const models = openrouterProvider.listModels();
		const target = models.find((m) => m.id !== session.snapshot().modelName);
		if (!target) throw new Error("preload didn't seed enough models");
		session.actions.setModel(target);
		const beforeUnsub = captured.length;

		unsubscribe();
		// Pick yet another model to ensure setModel doesn't no-op.
		const next = models.find((m) => m.id !== target.id);
		if (!next) throw new Error("preload didn't seed enough models");
		session.actions.setModel(next);

		expect(captured.length).toBe(beforeUnsub);
	});

	test("snapshot() reflects current state without subscribing", () => {
		const { session, unsubscribe } = buildSession();
		try {
			const initial = session.snapshot();
			expect(initial.agentName).toBe("reader");
			expect(typeof initial.modelName).toBe("string");
			expect(typeof initial.modelProvider).toBe("string");
			expect(typeof initial.contextWindow).toBe("number");
			expect(typeof initial.modelReasoning).toBe("boolean");
			expect(initial.thinkingLevel).toBeDefined();
		} finally {
			unsubscribe();
		}
	});
});
