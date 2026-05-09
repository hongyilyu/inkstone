import { afterEach, describe, expect, test } from "bun:test";
import {
	makeSuggestCommandTool,
	type SuggestCommandRequest,
	setSuggestCommandFn,
} from "@backend/agent/tools/suggest-command";
import type { AgentCommand } from "@backend/agent/types";
import { validateToolArguments } from "@mariozechner/pi-ai";

const articleCommand: AgentCommand = {
	name: "article",
	argHint: "[filename]",
	takesArgs: false,
	execute: () => {},
};

const ingestCommand: AgentCommand = {
	name: "ingest",
	takesArgs: false,
	execute: () => {},
};

const queryCommand: AgentCommand = {
	name: "query",
	argHint: "<question>",
	takesArgs: true,
	execute: () => {},
};

afterEach(() => {
	setSuggestCommandFn(null);
});

describe("suggest_command tool", () => {
	test("accepts a slash invocation and normalizes it for the resolver", async () => {
		const tool = makeSuggestCommandTool([articleCommand]);
		if (!tool) throw new Error("expected suggest_command tool");
		let seen: SuggestCommandRequest | null = null;
		setSuggestCommandFn(async (req) => {
			seen = req;
			return "cancelled";
		});

		const params = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-1",
			name: "suggest_command",
			arguments: {
				invocation: "/article foo.md",
				rationale: "User asked to read foo.",
			},
		});
		await tool.execute("call-1", params);

		expect(seen).toEqual({
			callId: "call-1",
			command: "article",
			args: "foo.md",
			rationale: "User asked to read foo.",
		});
	});

	test("rejects unknown slash verbs before the resolver runs", () => {
		const tool = makeSuggestCommandTool([articleCommand]);
		if (!tool) throw new Error("expected suggest_command tool");
		let called = false;
		setSuggestCommandFn(async () => {
			called = true;
			return "cancelled";
		});

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-unknown",
				name: "suggest_command",
				arguments: {
					invocation: "/missing foo.md",
					rationale: "Bad command.",
				},
			}),
		).toThrow('Validation failed for tool "suggest_command"');
		expect(called).toBe(false);
	});

	test("rejects the old structured command-plus-args shape", () => {
		const tool = makeSuggestCommandTool([articleCommand]);
		if (!tool) throw new Error("expected suggest_command tool");

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-legacy-shape",
				name: "suggest_command",
				arguments: {
					command: "article",
					args: "foo.md",
					rationale: "Legacy shape.",
				},
			}),
		).toThrow('Validation failed for tool "suggest_command"');
	});

	test("validates invocation argument shape from command metadata", () => {
		const tool = makeSuggestCommandTool([ingestCommand, queryCommand]);
		if (!tool) throw new Error("expected suggest_command tool");

		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-query-ok",
				name: "suggest_command",
				arguments: {
					invocation: "/query what did I save about tags?",
					rationale: "Question maps to query.",
				},
			}),
		).not.toThrow();
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-query-missing",
				name: "suggest_command",
				arguments: {
					invocation: "/query",
					rationale: "Missing question.",
				},
			}),
		).toThrow('Validation failed for tool "suggest_command"');
		expect(() =>
			validateToolArguments(tool, {
				type: "toolCall",
				id: "call-ingest-extra",
				name: "suggest_command",
				arguments: {
					invocation: "/ingest extra",
					rationale: "No-arg command with extra args.",
				},
			}),
		).toThrow('Validation failed for tool "suggest_command"');
	});

	test("preserves the rest of the invocation line as args", async () => {
		const tool = makeSuggestCommandTool([articleCommand]);
		if (!tool) throw new Error("expected suggest_command tool");
		let seen: SuggestCommandRequest | null = null;
		setSuggestCommandFn(async (req) => {
			seen = req;
			return "cancelled";
		});

		const params = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-spaces",
			name: "suggest_command",
			arguments: {
				invocation: "/article Collaborative Intelligence.md",
				rationale: "User asked for this article.",
			},
		});
		await tool.execute("call-spaces", params);

		expect(seen?.args).toBe("Collaborative Intelligence.md");
	});

	test("accepts a bare optional-arg invocation", async () => {
		const tool = makeSuggestCommandTool([articleCommand]);
		if (!tool) throw new Error("expected suggest_command tool");
		let seen: SuggestCommandRequest | null = null;
		setSuggestCommandFn(async (req) => {
			seen = req;
			return "cancelled";
		});

		const params = validateToolArguments(tool, {
			type: "toolCall",
			id: "call-bare-optional",
			name: "suggest_command",
			arguments: {
				invocation: "/article",
				rationale: "Surface the recommendation picker.",
			},
		});
		await tool.execute("call-bare-optional", params);

		expect(seen?.command).toBe("article");
		expect(seen?.args).toBe("");
	});
});
