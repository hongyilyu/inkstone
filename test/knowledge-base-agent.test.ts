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
import {
	KB_HUMAN_DIR,
	KB_RAW_DIR,
} from "@backend/agent/agents/knowledge-base/paths";

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
			{ path: "040 FORGE", write: "auto" },
			{ path: "090 SYSTEM/099 LLM Wiki", write: "confirm" },
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
