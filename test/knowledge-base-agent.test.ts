/**
 * Knowledge-base agent — scaffold-level invariants.
 *
 * Pins the registry inclusion, zone shape, and permission overlay
 * without depending on the workflow text or commands (those land in
 * later PRs of this stack). Vault fixture is seeded by
 * `test/preload.ts`.
 */

import { describe, expect, test } from "bun:test";
import { AGENTS, getAgentInfo } from "@backend/agent/agents";
import { knowledgeBaseAgent } from "@backend/agent/agents/knowledge-base";
import { buildKnowledgeBaseInstructions } from "@backend/agent/agents/knowledge-base/instructions";
import {
	KB_FORGE,
	KB_HUMAN_DIR,
	KB_RAW_DIR,
	KB_SYSTEM,
} from "@backend/agent/agents/knowledge-base/paths";
import { composeSystemPrompt } from "@backend/agent/compose";

import "./preload";

describe("knowledge-base agent — registry", () => {
	test("registered under name 'knowledge-base'", () => {
		expect(AGENTS.map((a) => a.name)).toContain("knowledge-base");
		expect(getAgentInfo("knowledge-base")).toBe(knowledgeBaseAgent);
	});
});

describe("knowledge-base agent — zones", () => {
	test("declares Forge as auto-write and the LLM Wiki system folder as confirm-write", () => {
		expect(knowledgeBaseAgent.zones).toEqual([
			{ path: KB_FORGE, write: "auto" },
			{ path: KB_SYSTEM, write: "confirm" },
		]);
	});
});

describe("knowledge-base agent — permission overlay", () => {
	test("blocks writes inside 010 RAW/ and 020 HUMAN/ on both write and edit", () => {
		const overlay = knowledgeBaseAgent.getPermissions?.();
		expect(overlay).toBeDefined();
		// Both `write` and `edit` carry a single `blockInsideDirs` rule
		// whose `dirs` array covers RAW + HUMAN. The shape is asserted
		// (not just keys-present) so a future overlay change has to
		// re-justify the policy block.
		const expectedRule = {
			kind: "blockInsideDirs",
			dirs: [KB_RAW_DIR, KB_HUMAN_DIR],
			reason: expect.stringContaining("read-only"),
		};
		expect(overlay?.write).toEqual([expectedRule]);
		expect(overlay?.edit).toEqual([expectedRule]);
	});
});

describe("knowledge-base agent — preloaded workflow bodies", () => {
	test("buildInstructions carries persona + freeform routing + all three workflow sections", () => {
		// This is the regression-critical assertion: if any workflow
		// section heading goes missing, the LLM silently loses that
		// capability with no other failure signal. Keep the headings
		// stable so this test catches the case.
		const body = buildKnowledgeBaseInstructions();
		expect(body).toContain("## Persona");
		expect(body).toContain("## Handling Freeform Requests");
		expect(body).toContain("suggest_command");
		expect(body).toContain("## Ingest Workflow");
		expect(body).toContain("## Query Workflow");
		expect(body).toContain("## Lint Workflow");
	});

	test("composed system prompt preserves zones, commands wrapper, and workflow bodies", () => {
		// Pin the composition: zones block is auto-emitted from
		// `info.zones`, the body is appended after, and the workflow
		// content survives intact.
		const prompt = composeSystemPrompt(knowledgeBaseAgent);
		expect(prompt).toContain("<your workspace>");
		expect(prompt).toContain(KB_FORGE);
		expect(prompt).toContain(KB_SYSTEM);
		expect(prompt).toContain("## Ingest Workflow");
		expect(prompt).toContain("## Query Workflow");
		expect(prompt).toContain("## Lint Workflow");
	});

	test("system prompt is byte-stable across composes (cache-safety invariant)", () => {
		const a = composeSystemPrompt(knowledgeBaseAgent);
		const b = composeSystemPrompt(knowledgeBaseAgent);
		expect(a).toBe(b);
	});
});
