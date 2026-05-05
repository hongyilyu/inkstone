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
import { exampleAgent } from "@backend/agent/agents/example";
import { readerAgent } from "@backend/agent/agents/reader";
import { composeSystemPrompt } from "@backend/agent/compose";
import type { AgentCommand, AgentInfo } from "@backend/agent/types";

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

	test("example (no commands) omits the block entirely", () => {
		const prompt = composeSystemPrompt(exampleAgent);
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

	test("example prompt is identical across back-to-back composes", () => {
		const a = composeSystemPrompt(exampleAgent);
		const b = composeSystemPrompt(exampleAgent);
		expect(a).toBe(b);
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
