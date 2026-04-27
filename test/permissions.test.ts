/**
 * Reader permission dispatcher + `/article` command tests.
 *
 * Ported from the hand-rolled smoke harness at
 * `/tmp/inkstone-phase1/smoke4.ts`. Covers:
 *
 * - zone + custom overlay interaction for every reader tool call shape
 *   (read/write/edit against Articles/Notes/Scraps/unzoned/outside vault,
 *   prefix-attack siblings),
 * - `/article` command validation (content load, missing, escape,
 *   empty, whitespace, symlink reject).
 *
 * Vault fixture lives in `test/preload.ts` — it must be seeded before
 * any `@backend/*` import resolves, because `constants.ts` captures
 * `VAULT_DIR` at module-eval time.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readerAgent } from "@backend/agent/agents/reader";
import {
	dispatchBeforeToolCall,
	setConfirmFn,
} from "@backend/agent/permissions";
import { composeOverlay } from "@backend/agent/zones";
import { VAULT } from "./preload";

// ---------------------------------------------------------------------------
// Shared confirm-function harness.
// Every dispatch test resets this counter in `beforeEach` and reads it at
// the end. The confirmFn always approves — cases that expect a `confirm`
// verify both the allow decision AND the non-zero prompt count. Cases
// that expect a silent allow verify the prompt count is zero (no
// accidental prompts).
// ---------------------------------------------------------------------------
let confirmCalls = 0;
setConfirmFn(async () => {
	confirmCalls++;
	return true;
});

function makeCtx(toolName: string, args: Record<string, unknown>) {
	// pi-agent-core's `BeforeToolCallContext` is structurally typed; we only
	// touch `toolCall.name` and `args` in the dispatcher, so a minimal
	// stand-in is safer than importing the full runtime type.
	return {
		toolCall: { name: toolName, id: "t1", args, description: "" },
		args,
		state: {},
	} as unknown as Parameters<typeof dispatchBeforeToolCall>[0];
}

// ---------------------------------------------------------------------------
// Permission dispatcher cases — parameterized via test.each so adding
// a case is one row in the table, not a whole new `test()` block.
// ---------------------------------------------------------------------------

type DispatchCase = {
	label: string;
	toolName: string;
	args: Record<string, unknown>;
	expectedDecision: "allow" | "block";
	expectedConfirms: number;
};

const dispatchCases: DispatchCase[] = [
	{
		label: "read any article — allow",
		toolName: "read",
		args: { path: `${VAULT}/010 RAW/013 Articles/foo.md` },
		expectedDecision: "allow",
		expectedConfirms: 0,
	},
	{
		label: "write to Articles (foo.md) — block (static rule)",
		toolName: "write",
		args: {
			path: `${VAULT}/010 RAW/013 Articles/foo.md`,
			content: "overwrite",
		},
		expectedDecision: "block",
		expectedConfirms: 0,
	},
	{
		label: "write to Articles (bar.md) — block (rule covers every article)",
		toolName: "write",
		args: {
			path: `${VAULT}/010 RAW/013 Articles/bar.md`,
			content: "overwrite",
		},
		expectedDecision: "block",
		expectedConfirms: 0,
	},
	{
		label: "edit Articles frontmatter (foo.md) — confirm once, allow",
		toolName: "edit",
		args: {
			path: `${VAULT}/010 RAW/013 Articles/foo.md`,
			edits: [
				{ oldText: "reading_intent: keeper", newText: "reading_intent: joy" },
			],
		},
		expectedDecision: "allow",
		expectedConfirms: 1,
	},
	{
		label: "edit Articles frontmatter (bar.md) — confirm once, allow",
		toolName: "edit",
		args: {
			path: `${VAULT}/010 RAW/013 Articles/bar.md`,
			edits: [{ oldText: "title: bar", newText: "title: bar updated" }],
		},
		expectedDecision: "allow",
		expectedConfirms: 1,
	},
	{
		label: "edit Articles body — block (frontmatterOnlyInDirs), ZERO confirms",
		toolName: "edit",
		args: {
			path: `${VAULT}/010 RAW/013 Articles/foo.md`,
			edits: [{ oldText: "Body paragraph.", newText: "Mutated." }],
		},
		expectedDecision: "block",
		expectedConfirms: 0,
	},
	{
		label: "write to Notes — confirm once, allow (zone rule)",
		toolName: "write",
		args: { path: `${VAULT}/020 HUMAN/023 Notes/x.md`, content: "x" },
		expectedDecision: "allow",
		expectedConfirms: 1,
	},
	{
		label: "write to Scraps — confirm once, allow (zone rule)",
		toolName: "write",
		args: { path: `${VAULT}/020 HUMAN/022 Scraps/x.md`, content: "x" },
		expectedDecision: "allow",
		expectedConfirms: 1,
	},
	{
		label: "write to unzoned vault path — allow, no confirm",
		toolName: "write",
		args: { path: `${VAULT}/040 FORGE/x.md`, content: "x" },
		expectedDecision: "allow",
		expectedConfirms: 0,
	},
	{
		label: "write outside vault — block (baseline insideDirs)",
		toolName: "write",
		args: { path: "/etc/passwd", content: "x" },
		expectedDecision: "block",
		expectedConfirms: 0,
	},
	{
		label: "prefix-attack sibling of Articles — allow (not in zone)",
		toolName: "write",
		args: {
			path: `${VAULT}/010 RAW/013 Articles-stash/x.md`,
			content: "x",
		},
		expectedDecision: "allow",
		expectedConfirms: 0,
	},
];

describe("dispatchBeforeToolCall + reader overlay", () => {
	beforeEach(() => {
		confirmCalls = 0;
	});

	test.each(dispatchCases)("$label", async (c) => {
		const overlay = composeOverlay(readerAgent);
		const result = await dispatchBeforeToolCall(makeCtx(c.toolName, c.args), overlay);
		const actual = result?.block ? "block" : "allow";
		expect(actual).toBe(c.expectedDecision);
		expect(confirmCalls).toBe(c.expectedConfirms);
	});
});

// ---------------------------------------------------------------------------
// `/article` command tests — each case has a distinct shape (throw vs
// prompt vs prompt-with-content), so they stay as separate test blocks.
// ---------------------------------------------------------------------------

describe("reader /article command", () => {
	// biome-ignore lint/style/noNonNullAssertion: readerAgent.commands is declared in source
	const articleCommand = readerAgent.commands!.find((c) => c.name === "article");

	test("command is declared", () => {
		expect(articleCommand).toBeDefined();
	});

	test("foo.md — prompts with path + content", async () => {
		let promptCalledWith: string | null = null;
		const fakePrompt = async (text: string) => {
			promptCalledWith = text;
		};
		// biome-ignore lint/style/noNonNullAssertion: guarded by first test
		await articleCommand!.execute("foo.md", fakePrompt);
		expect(promptCalledWith).not.toBeNull();
		// Narrow the type for subsequent assertions — we've just verified non-null.
		const text = promptCalledWith as unknown as string;
		expect(text).toContain(`${VAULT}/010 RAW/013 Articles/foo.md`);
		expect(text).toContain("Body paragraph.");
	});

	test("missing.md — throws 'Article not found'", async () => {
		const fakePrompt = async () => {};
		// biome-ignore lint/style/noNonNullAssertion: guarded by first test
		await expect(articleCommand!.execute("missing.md", fakePrompt)).rejects.toThrow(/not found/i);
	});

	test("../outside.md — throws (escape attempt)", async () => {
		const fakePrompt = async () => {};
		// biome-ignore lint/style/noNonNullAssertion: guarded by first test
		await expect(articleCommand!.execute("../outside.md", fakePrompt)).rejects.toThrow(
			/not a file inside|not found|not a regular file/i,
		);
	});

	test("empty args — throws 'Missing filename'", async () => {
		const fakePrompt = async () => {};
		// biome-ignore lint/style/noNonNullAssertion: guarded by first test
		await expect(articleCommand!.execute("", fakePrompt)).rejects.toThrow(/missing filename/i);
	});

	test("whitespace-only args — throws 'Missing filename'", async () => {
		const fakePrompt = async () => {};
		// biome-ignore lint/style/noNonNullAssertion: guarded by first test
		await expect(articleCommand!.execute("   ", fakePrompt)).rejects.toThrow(/missing filename/i);
	});

	test("sneak.md (symlink) — throws (lstat reject)", async () => {
		const fakePrompt = async () => {};
		// biome-ignore lint/style/noNonNullAssertion: guarded by first test
		await expect(articleCommand!.execute("sneak.md", fakePrompt)).rejects.toThrow(/symlink/i);
	});
});
