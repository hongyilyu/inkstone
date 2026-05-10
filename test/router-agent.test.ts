/**
 * Router agent — system prompt shape + dispatch tool exposure.
 *
 * Per ADR 0007, the router is a normal `AgentInfo` registry entry whose
 * only job is to classify a freeform first message into a target agent
 * via its single `dispatch` tool. This test pins the prompt + tool shape
 * so a regression that drops the tiebreaker rule, omits an agent's
 * description, or changes the dispatch enum trips a focused failure.
 */
import { describe, expect, test } from "bun:test";
import { AGENTS, getAgentInfo } from "@backend/agent/agents";
import { routerAgent } from "@backend/agent/agents/router";
import { dispatchTool } from "@backend/agent/agents/router/tools/dispatch";
import { composeSystemPrompt } from "@backend/agent/compose";

describe("routerAgent", () => {
	test("is registered in AGENTS", () => {
		expect(AGENTS.find((a) => a.name === "router")).toBe(routerAgent);
	});

	test("composeSystemPrompt includes every non-router agent's description + tiebreaker", () => {
		const prompt = composeSystemPrompt(routerAgent);
		const targets = AGENTS.filter((a) => a.name !== "router");
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			expect(prompt).toContain(target.name);
			expect(prompt).toContain(target.description);
		}
		// Tiebreaker per ADR 0007.
		expect(prompt).toContain("freeform-capable");
	});

	test("composeSystemPrompt enumerates each target's commands", () => {
		// Commands give the router a precise vocabulary to match user
		// intent against — "audit my vault" → /lint, "read foo.md" →
		// /article, etc. Build the prompt programmatically so adding a
		// command anywhere in the registry widens the router prompt
		// without touching this file. This test pins that contract.
		const prompt = composeSystemPrompt(routerAgent);
		const targets = AGENTS.filter((a) => a.name !== "router");
		for (const target of targets) {
			for (const cmd of target.commands ?? []) {
				if (!cmd.description) continue;
				expect(prompt).toContain(`/${cmd.name}`);
				expect(prompt).toContain(cmd.description);
			}
		}
	});

	test("agents with no commands render '(none — plain-chat only)'", () => {
		// The router needs to know an agent is purely conversational so
		// it doesn't hallucinate a verb. The placeholder line keeps the
		// shape uniform across agents with and without commands.
		const prompt = composeSystemPrompt(routerAgent);
		const noCommandAgents = AGENTS.filter(
			(a) => a.name !== "router" && (a.commands?.length ?? 0) === 0,
		);
		// Only assert the placeholder for agents that genuinely have
		// no commands — Reader and KB both have commands today, so this
		// branch is exercised the moment any plain-chat agent lands.
		for (const _ of noCommandAgents) {
			expect(prompt).toContain("(none — plain-chat only)");
			break;
		}
	});

	test("router has the dispatch tool in extraTools", () => {
		expect(routerAgent.extraTools).toContainEqual(dispatchTool);
	});

	test("composeTools(routerAgent) returns ONLY [dispatch] (no BASE_TOOLS)", async () => {
		// Per ADR 0007 the router is a one-shot classifier with exactly
		// one tool. Without `omitBaseTools: true` the router would
		// inherit `read` (with the vault baseline) and `update_sidebar`
		// from `BASE_TOOLS`, letting a misbehaving model inspect vault
		// files before dispatching — privacy + design-integrity issue.
		// This test pins the opt-out.
		const { composeTools } = await import("@backend/agent/compose");
		const tools = composeTools(routerAgent);
		const names = tools.map((t) => t.name);
		expect(names).toEqual(["dispatch"]);
	});

	test("getAgentInfo('router') resolves to routerAgent", () => {
		expect(getAgentInfo("router")).toBe(routerAgent);
	});
});

describe("dispatchTool", () => {
	test("name is 'dispatch'", () => {
		expect(dispatchTool.name).toBe("dispatch");
	});

	test("baseline is empty (no filesystem rules)", () => {
		expect(dispatchTool.baseline).toEqual([]);
	});

	test("parameters.agent is a typebox literal-union over non-router agents", () => {
		// Provider-side structured-output enforcement (Anthropic enum,
		// OpenAI structured outputs) inspects this schema and rejects
		// any tool call whose `agent` value isn't in the enum. Without
		// the enum, the model can emit "writer" or "router" and only
		// fail at `execute()`'s defensive check — surfacing as a
		// silent-skip in the routing seam, not a clean misroute.
		const schema = dispatchTool.parameters as {
			properties: { agent: { anyOf?: { const: string }[]; const?: string } };
		};
		const targets = AGENTS.filter((a) => a.name !== "router").map(
			(a) => a.name,
		);
		const agentField = schema.properties.agent;
		// Two-or-more non-router agents → Type.Union of literals →
		// `anyOf: [{ const: ... }, ...]`. Single agent → bare literal.
		const literals = agentField.anyOf
			? agentField.anyOf.map((m) => m.const)
			: agentField.const
				? [agentField.const]
				: [];
		expect([...literals].sort()).toEqual([...targets].sort());
		// Specifically: "router" must not appear.
		expect(literals).not.toContain("router");
	});

	test("execute returns { agent } for a valid target", async () => {
		const result = await dispatchTool.execute("call-1", { agent: "reader" });
		expect(result.details).toEqual({ agent: "reader" });
		// Per ADR 0007 the router's turn is sealed after dispatch — the
		// tool sets `terminate: true` so pi-agent-core stops the loop.
		expect(result.terminate).toBe(true);
	});

	test("execute rejects targets not in the registry", async () => {
		// `dispatchTool.execute` is async — its `throw` becomes a
		// rejected Promise, not a synchronous throw. Asserting via
		// `expect(() => fn()).toThrow()` would silently pass (the
		// wrapper just returns the rejected Promise). `.rejects.toThrow()`
		// is the matcher that actually awaits the rejection.
		await expect(
			dispatchTool.execute("call-x", { agent: "router" }),
		).rejects.toThrow();
		await expect(
			dispatchTool.execute("call-y", { agent: "nonexistent" }),
		).rejects.toThrow();
	});
});
