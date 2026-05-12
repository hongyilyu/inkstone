/**
 * Agent system-prompt composition tests.
 *
 * Pins the shape of `composeSystemPrompt` against the shipped agents:
 * `<your workspace>` projection from the permission overlay, commands
 * block, body order + join, and byte-stability across back-to-back
 * calls (required so Anthropic `cache_control` / Bedrock `cachePoint`
 * prefixes don't invalidate between turns — see D9 in
 * `docs/AGENT-DESIGN.md`). The workspace projection contract is the
 * "literally the same bytes" promise from ADR 0009.
 *
 * Vault fixture is seeded by `test/preload.ts`.
 */

import { describe, expect, test } from "bun:test";
import { knowledgeBaseAgent } from "@backend/agent/agents/knowledge-base";
import { readerAgent } from "@backend/agent/agents/reader";
import { buildReaderInstructions } from "@backend/agent/agents/reader/instructions";
import { composeSystemPrompt, composeTools } from "@backend/agent/compose";
import { VAULT_DIR } from "@backend/agent/constants";
import {
	editTool,
	readTool,
	updateSidebarTool,
	writeTool,
} from "@backend/agent/tools";
import { makeListKeysTool, makeSearchTool } from "@backend/agent/tools/search";
import { makeSuggestCommandTool } from "@backend/agent/tools/suggest-command";
import type { AgentCommand, AgentInfo } from "@backend/agent/types";

import "./preload";

function makeAgent(overrides: Partial<AgentInfo>): AgentInfo {
	return {
		name: "test",
		displayName: "Test",
		description: "test agent",
		colorKey: "accent",
		extraTools: [],
		buildInstructions: () => "body",
		...overrides,
	};
}

describe("composeSystemPrompt — <env> block", () => {
	test("emits a leading <env> block with today's date in YYYY-MM-DD", () => {
		const prompt = composeSystemPrompt(readerAgent);
		expect(prompt.startsWith("<env>\n")).toBe(true);
		expect(prompt).toContain("</env>");
		// Local-time ISO date — match the format, not a fixed string,
		// so the test stays stable across days.
		expect(prompt).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
	});

	test("env block is present even on a minimal agent (no workspace, no commands)", () => {
		// Pins that the env block stands alone — earlier "leading section"
		// assertions only fire on agents with a workspace block. A
		// minimal agent must still receive the date.
		const minimal = makeAgent({});
		const prompt = composeSystemPrompt(minimal);
		expect(prompt.startsWith("<env>\n")).toBe(true);
		expect(prompt).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
	});

	test("env date matches the system clock at compose time", () => {
		// The date the LLM reads must be the date the host says it is.
		const d = new Date();
		const expected =
			`${d.getFullYear()}-` +
			`${String(d.getMonth() + 1).padStart(2, "0")}-` +
			`${String(d.getDate()).padStart(2, "0")}`;
		const prompt = composeSystemPrompt(makeAgent({}));
		expect(prompt).toContain(`Today's date: ${expected}`);
	});
});

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

describe("composeSystemPrompt — <your workspace> from permission rules", () => {
	// Per ADR 0009, the <your workspace> block is projected from the same
	// merged permission overlay the dispatcher evaluates — single source of
	// truth, no drift. Each test here pins one rule-kind → prose mapping;
	// integration with shipped agents is covered by separate cases.

	test("agent with no getPermissions: no <your workspace> block", () => {
		const agent = makeAgent({});
		const prompt = composeSystemPrompt(agent);
		expect(prompt).not.toContain("<your workspace>");
		expect(prompt).not.toContain("</your workspace>");
	});

	test("insideDirs (write tool) renders under 'You can write to:' as 'write freely'", () => {
		const agent = makeAgent({
			extraTools: [writeTool],
			getPermissions: () => ({
				[writeTool.name]: [
					{
						kind: "insideDirs",
						dirs: [`${VAULT_DIR}/040 FORGE`],
					},
				],
			}),
		});
		const prompt = composeSystemPrompt(agent);
		expect(prompt).toContain("<your workspace>");
		expect(prompt).toContain("You can write to:");
		expect(prompt).toContain("- 040 FORGE (write freely)");
	});

	test("confirmDirs replaces '(write freely)' with '(confirm before each write)'", () => {
		const dir = `${VAULT_DIR}/090 SYSTEM`;
		const agent = makeAgent({
			extraTools: [writeTool],
			getPermissions: () => ({
				[writeTool.name]: [
					{ kind: "insideDirs", dirs: [dir] },
					{ kind: "confirmDirs", dirs: [dir] },
				],
			}),
		});
		const prompt = composeSystemPrompt(agent);
		expect(prompt).toContain("- 090 SYSTEM (confirm before each write)");
		expect(prompt).not.toContain("- 090 SYSTEM (write freely)");
	});

	test("frontmatterOnlyInDirs (edit tool) renders under 'Edits restricted to frontmatter in:'", () => {
		const articles = `${VAULT_DIR}/010 RAW/013 Articles`;
		const agent = makeAgent({
			extraTools: [writeTool, editTool],
			getPermissions: () => ({
				[writeTool.name]: [
					{ kind: "insideDirs", dirs: [`${VAULT_DIR}/040 FORGE`] },
				],
				[editTool.name]: [{ kind: "frontmatterOnlyInDirs", dirs: [articles] }],
			}),
		});
		const prompt = composeSystemPrompt(agent);
		expect(prompt).toContain("Edits restricted to frontmatter in:");
		expect(prompt).toContain("  - 010 RAW/013 Articles");
	});

	test("knowledgeBaseAgent: Forge is auto, System is confirm, no other prompt sections", () => {
		const prompt = composeSystemPrompt(knowledgeBaseAgent);
		expect(prompt).toContain("<your workspace>");
		expect(prompt).toContain("  - 040 FORGE (write freely)");
		expect(prompt).toContain(
			"  - 090 SYSTEM/099 LLM Wiki (confirm before each write)",
		);
		// RAW + HUMAN are not in the allowlist, so the dispatcher rejects
		// writes against them with the generic insideDirs reason. The
		// LifeOS read-only policy is documented in the agent's workflow
		// instructions, not as a workspace-block clause.
		expect(prompt).not.toContain("Writes blocked in:");
	});

	test("readerAgent: Articles is blocked + frontmatter-only, Scraps/Notes are confirm-write", () => {
		// End-to-end against the shipped reader. Pins the user-visible fix:
		// Articles must NOT show as writable (the dispatcher blocks every
		// write); Articles must appear under blocked + frontmatter-only;
		// Scraps and Notes remain confirm-write.
		const prompt = composeSystemPrompt(readerAgent);
		expect(prompt).toContain("<your workspace>");
		expect(prompt).toContain("You can write to:");
		expect(prompt).toContain(
			"  - 020 HUMAN/022 Scraps (confirm before each write)",
		);
		expect(prompt).toContain(
			"  - 020 HUMAN/023 Notes (confirm before each write)",
		);
		// Articles is excluded from `write`'s allowlist (any write is rejected
		// by `insideDirs`) and present only under "Edits restricted to
		// frontmatter in:".
		expect(prompt).not.toContain(
			"010 RAW/013 Articles (confirm before each write)",
		);
		expect(prompt).not.toContain("010 RAW/013 Articles (write freely)");
		expect(prompt).toContain("Edits restricted to frontmatter in:");
		expect(prompt).toContain("  - 010 RAW/013 Articles");
	});
});

describe("composeSystemPrompt — section order", () => {
	test("env precedes workspace precedes commands precedes body", () => {
		const prompt = composeSystemPrompt(readerAgent);
		const envIdx = prompt.indexOf("<env>");
		const workspaceIdx = prompt.indexOf("<your workspace>");
		const commandsIdx = prompt.indexOf("<commands>");
		const bodyIdx = prompt.indexOf("Reading Guide Persona");
		expect(envIdx).toBe(0);
		expect(workspaceIdx).toBeGreaterThan(envIdx);
		expect(commandsIdx).toBeGreaterThan(workspaceIdx);
		expect(bodyIdx).toBeGreaterThan(commandsIdx);
	});

	test("sections separated by blank lines", () => {
		const prompt = composeSystemPrompt(readerAgent);
		// Env block closes, blank line, workspace block opens.
		expect(prompt).toContain("</env>\n\n<your workspace>");
		// Workspace block closes, blank line, commands block opens.
		expect(prompt).toContain("</your workspace>\n\n<commands>");
	});
});

describe("composeTools — permission coverage", () => {
	test("known shipped tools compose without a baseline coverage error", () => {
		expect(composeTools(readerAgent).map((t) => t.name)).toContain("read");
	});

	test("shared mutating file tools require an insideDirs workspace rule", () => {
		const agent = makeAgent({ extraTools: [writeTool] });
		expect(() => composeTools(agent)).toThrow(
			"Agent 'test' composes mutating file tools but declares no writable workspace",
		);
	});
});

// Pins the per-tool baseline data on the InkstoneTool shape. Asserts
// against the tool definition (not a registry) so the contract stays
// local + grep-able.
describe("InkstoneTool baseline declarations", () => {
	test("readTool declares insideDirs[VAULT_DIR] baseline", () => {
		expect(readTool.baseline).toBeDefined();
		expect(readTool.baseline).toHaveLength(1);
		const rule = readTool.baseline[0];
		expect(rule?.kind).toBe("insideDirs");
		if (rule?.kind === "insideDirs") {
			expect(rule.dirs).toEqual([VAULT_DIR]);
		}
	});

	test("writeTool declares insideDirs[VAULT_DIR] baseline", () => {
		expect(writeTool.baseline).toBeDefined();
		expect(writeTool.baseline).toHaveLength(1);
		const rule = writeTool.baseline[0];
		expect(rule?.kind).toBe("insideDirs");
		if (rule?.kind === "insideDirs") {
			expect(rule.dirs).toEqual([VAULT_DIR]);
		}
	});

	test("editTool declares insideDirs[VAULT_DIR] baseline", () => {
		expect(editTool.baseline).toBeDefined();
		expect(editTool.baseline).toHaveLength(1);
		const rule = editTool.baseline[0];
		expect(rule?.kind).toBe("insideDirs");
		if (rule?.kind === "insideDirs") {
			expect(rule.dirs).toEqual([VAULT_DIR]);
		}
	});

	test("updateSidebarTool declares empty baseline (no FS access)", () => {
		expect(Array.isArray(updateSidebarTool.baseline)).toBe(true);
		expect(updateSidebarTool.baseline).toHaveLength(0);
	});

	test("makeSearchTool returns InkstoneTool with empty baseline", () => {
		const tool = makeSearchTool({
			dir: VAULT_DIR,
			name: "search_test",
			description: "fixture",
		});
		expect(Array.isArray(tool.baseline)).toBe(true);
		expect(tool.baseline).toHaveLength(0);
	});

	test("makeListKeysTool returns InkstoneTool with empty baseline", () => {
		const tool = makeListKeysTool({
			dir: VAULT_DIR,
			name: "list_keys_test",
			description: "fixture",
		});
		expect(Array.isArray(tool.baseline)).toBe(true);
		expect(tool.baseline).toHaveLength(0);
	});

	test("makeSuggestCommandTool returns InkstoneTool with empty baseline", () => {
		const fakeCommand: AgentCommand = { name: "ping", execute: () => {} };
		// Factory returns `null` for an empty command list — pass a
		// fixture command so we get a tool back.
		const tool = makeSuggestCommandTool([fakeCommand]);
		if (tool === null) throw new Error("expected non-null tool");
		expect(Array.isArray(tool.baseline)).toBe(true);
		expect(tool.baseline).toHaveLength(0);
	});
});
