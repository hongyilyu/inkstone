/**
 * Agent system-prompt composition tests.
 *
 * Pins the shape of `composeSystemPrompt` against the shipped agents:
 * zones block, commands block, body order + join, and byte-stability
 * across back-to-back calls (required so Anthropic `cache_control` /
 * Bedrock `cachePoint` prefixes don't invalidate between turns —
 * see D9 in `docs/AGENT-DESIGN.md`).
 *
 * Vault fixture is seeded by `test/preload.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readerAgent } from "@backend/agent/agents/reader";
import { buildReaderInstructions } from "@backend/agent/agents/reader/instructions";
import { composeSystemPrompt, composeTools } from "@backend/agent/compose";
import { writeTool } from "@backend/agent/tools";
import type { AgentCommand, AgentInfo } from "@backend/agent/types";
import type { AgentTool } from "@mariozechner/pi-agent-core";

import "./preload";

function makeAgent(overrides: Partial<AgentInfo>): AgentInfo {
	return {
		name: "test",
		displayName: "Test",
		description: "test agent",
		colorKey: "accent",
		extraTools: [],
		zones: [],
		buildInstructions: () => "body",
		...overrides,
	};
}

describe("composeSystemPrompt — commands block", () => {
	test("reader includes a <commands> block listing /article", () => {
		const prompt = composeSystemPrompt(readerAgent);
		expect(prompt).toContain("<commands>");
		expect(prompt).toContain("</commands>");
		// The preamble line is part of the contract the LLM reads —
		// pin it so a reword doesn't silently change the framing.
		expect(prompt).toContain("User-invoked commands available:");
		// One line per command with name + argHint + description.
		expect(prompt).toContain("/article [filename]");
		expect(prompt).toContain("Open an article for guided reading");
	});

	test("agent without commands omits the block entirely", () => {
		// Use the inline `makeAgent` helper as a minimal-agent fixture
		// instead of pulling in a real shipped agent — the assertion
		// pins composer behavior, not any specific agent.
		const agent = makeAgent({});
		const prompt = composeSystemPrompt(agent);
		expect(prompt).not.toContain("<commands>");
		expect(prompt).not.toContain("</commands>");
	});

	test("agent with commands: [] (empty array) omits the block", () => {
		// Pins the empty-array branch distinctly from the
		// `commands === undefined` path above — both currently collapse
		// through the same length check, but a future refactor to
		// `info.commands && info.commands.length > 0` would regress
		// silently without this case.
		const agent = makeAgent({ commands: [] });
		expect(composeSystemPrompt(agent)).not.toContain("<commands>");
	});

	test("agent with commands but no descriptions omits the block", () => {
		const silent: AgentCommand = { name: "foo", execute: () => {} };
		const agent = makeAgent({ commands: [silent] });
		const prompt = composeSystemPrompt(agent);
		expect(prompt).not.toContain("<commands>");
	});

	test("mixed described + undescribed commands only surface the described ones", () => {
		const described: AgentCommand = {
			name: "foo",
			description: "foo does foo",
			execute: () => {},
		};
		const silent: AgentCommand = { name: "bar", execute: () => {} };
		const agent = makeAgent({ commands: [described, silent] });
		const prompt = composeSystemPrompt(agent);
		expect(prompt).toContain("/foo — foo does foo");
		expect(prompt).not.toContain("/bar");
	});

	test("commands without argHint render bare /name", () => {
		const cmd: AgentCommand = {
			name: "clear",
			description: "clear conversation",
			execute: () => {},
		};
		const agent = makeAgent({ commands: [cmd] });
		const prompt = composeSystemPrompt(agent);
		expect(prompt).toContain("/clear — clear conversation");
		expect(prompt).not.toContain("/clear  —"); // no double-space when argHint absent
	});
});

describe("composeSystemPrompt — byte-stability", () => {
	test("reader prompt is identical across back-to-back composes", () => {
		// System-prompt stability invariant — drift would invalidate
		// Anthropic `cache_control` prefixes mid-session.
		const a = composeSystemPrompt(readerAgent);
		const b = composeSystemPrompt(readerAgent);
		expect(a).toBe(b);
	});

	test("minimal-agent prompt is identical across back-to-back composes", () => {
		const minimal = makeAgent({});
		const a = composeSystemPrompt(minimal);
		const b = composeSystemPrompt(minimal);
		expect(a).toBe(b);
	});
});

describe("composeSystemPrompt — reader freeform-request guidance", () => {
	test("reader's persona teaches the list_keys → search → suggest flow", () => {
		const prompt = composeSystemPrompt(readerAgent);
		// The generalize-fallback paragraph has to reach the LLM —
		// without it, plain-chat prompts get swallowed into the Stage
		// 1 rails and the search tools go unused.
		expect(prompt).toContain("Handling Freeform Requests");
		expect(prompt).toContain("list_keys");
		expect(prompt).toContain("search");
		// Step 3 must route through suggest_command, not tell the user
		// to type the slash themselves (regressing to the pre-cleanup
		// prose left the LLM with a dead-end and it answered in prose
		// instead of reaching for the tool).
		expect(prompt).toContain("suggest_command");
	});

	test("reader's persona is generic — no Obsidian, no command-specific /article refs", () => {
		// Assert against the persona helper directly, not the composed
		// prompt: the commands block injected by `composeCommandsBlock`
		// legitimately surfaces `/article` in the system prompt. The
		// invariant being guarded here is that the *persona text* stays
		// editor-agnostic so it's reusable across future reader
		// commands (e.g. `/book`) — see AGENT-DESIGN.md D12.
		const persona = buildReaderInstructions();
		expect(persona).not.toMatch(/obsidian/i);
		expect(persona).not.toContain("/article");
	});

	test("reader's agent prompt no longer carries the 6-stage workflow", () => {
		// Workflow moved out of the agent system prompt into `/article`'s
		// opening user message — guard against a regression where it
		// gets re-merged into the agent prompt. See PR4 rationale in
		// `docs/AGENT-DESIGN.md`.
		const prompt = composeSystemPrompt(readerAgent);
		expect(prompt).not.toContain("Stage 1: Mode Selection");
		expect(prompt).not.toContain(
			"Stage 5: Preserve at the Smallest Useful Size",
		);
		expect(prompt).not.toContain("SCRAP_FILE");
		expect(prompt).not.toContain("File Rules");
	});
});

describe("composeSystemPrompt — section order", () => {
	test("zones block precedes commands block precedes body", () => {
		const prompt = composeSystemPrompt(readerAgent);
		const zonesIdx = prompt.indexOf("<your workspace>");
		const commandsIdx = prompt.indexOf("<commands>");
		const bodyIdx = prompt.indexOf("Reading Guide Persona");
		expect(zonesIdx).toBeGreaterThanOrEqual(0);
		expect(commandsIdx).toBeGreaterThan(zonesIdx);
		expect(bodyIdx).toBeGreaterThan(commandsIdx);
	});

	test("sections separated by blank lines", () => {
		const prompt = composeSystemPrompt(readerAgent);
		// Zones block closes, blank line, commands block opens.
		expect(prompt).toContain("</your workspace>\n\n<commands>");
	});
});

describe("composeTools — permission coverage", () => {
	test("known shipped tools compose without a baseline coverage error", () => {
		expect(composeTools(readerAgent).map((t) => t.name)).toContain("read");
	});

	test("unknown baseline-free extra tool fails loudly", () => {
		const unsafeTool = {
			name: "unsafe_extra",
			label: "Unsafe",
			description: "fixture",
			parameters: {},
			execute: async () => ({ type: "text", content: "ok" }),
		} as unknown as AgentTool<any>;
		const agent = makeAgent({ extraTools: [unsafeTool] });
		expect(() => composeTools(agent)).toThrow(
			"Tool 'unsafe_extra' on agent 'test' has no permission baseline",
		);
	});

	test("shared mutating file tools require declared write zones", () => {
		const agent = makeAgent({ extraTools: [writeTool], zones: [] });
		expect(() => composeTools(agent)).toThrow(
			"Agent 'test' composes mutating file tools but declares no write zones.",
		);
	});
});
