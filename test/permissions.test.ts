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
	computePublishedBand,
	computeReadingBucket,
	computeReadingScore,
	computeSavedBand,
	parseFrontmatter,
	recommendArticles,
} from "@backend/agent/agents/reader/recommendations";
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
	// Unicode-space normalization — guards the H5 byte-equality invariant.
	// pi-coding-agent runs `normalizeUnicodeSpaces` before the tool reads
	// the file; the dispatcher must fold the same bytes or the sandbox
	// decision won't match what the tool actually touches.
	{
		label:
			"NBSP (\\u00A0) in Articles path — still routed through the Articles zone (edit frontmatter → confirm)",
		toolName: "edit",
		args: {
			// `010\u00A0RAW` in the caller's string; after normalization
			// becomes `010 RAW` which is the real zone prefix.
			path: `${VAULT}/010\u00A0RAW/013 Articles/foo.md`,
			edits: [
				{ oldText: "reading_intent: keeper", newText: "reading_intent: joy" },
			],
		},
		expectedDecision: "allow",
		expectedConfirms: 1,
	},
	{
		label:
			"narrow no-break space (\\u202F) outside vault — blocked by insideDirs baseline",
		toolName: "write",
		args: {
			// Post-normalization: `/tmp foo/bar.md` — still outside VAULT.
			path: "/tmp\u202Ffoo/bar.md",
			content: "x",
		},
		expectedDecision: "block",
		expectedConfirms: 0,
	},
];

describe("dispatchBeforeToolCall + reader overlay", () => {
	beforeEach(() => {
		confirmCalls = 0;
	});

	test.each(dispatchCases)("$label", async (c) => {
		const overlay = composeOverlay(readerAgent);
		const result = await dispatchBeforeToolCall(
			makeCtx(c.toolName, c.args),
			overlay,
		);
		const actual = result?.block ? "block" : "allow";
		expect(actual).toBe(c.expectedDecision);
		expect(confirmCalls).toBe(c.expectedConfirms);
	});
});

// ---------------------------------------------------------------------------
// Recommendation scoring tests — verify the index.base ranking logic port.
// ---------------------------------------------------------------------------

describe("recommendations — scoring helpers", () => {
	test("parseFrontmatter — extracts known keys", () => {
		const content = `---\ntitle: "Test Article"\npublished: 2026-04-20\ndescription: A short desc\nreading_completed: 2026-04-25\nauthor: Someone\n---\nBody`;
		const fm = parseFrontmatter(content);
		expect(fm.title).toBe("Test Article");
		expect(fm.published).toBe("2026-04-20");
		expect(fm.description).toBe("A short desc");
		expect(fm.reading_completed).toBe("2026-04-25");
		// `author` is not in the known-keys set.
		expect((fm as Record<string, unknown>).author).toBeUndefined();
	});

	test("parseFrontmatter — handles single-quoted values", () => {
		const content = `---\ntitle: 'Hello World'\n---\n`;
		expect(parseFrontmatter(content).title).toBe("Hello World");
	});

	test("parseFrontmatter — no frontmatter returns empty", () => {
		expect(parseFrontmatter("No frontmatter here")).toEqual({});
	});

	test("computeSavedBand — new/recent/old", () => {
		const now = new Date("2026-04-29");
		// 3 days ago → new
		expect(computeSavedBand(new Date("2026-04-26").getTime(), now)).toBe("new");
		// 10 days ago → recent
		expect(computeSavedBand(new Date("2026-04-19").getTime(), now)).toBe(
			"recent",
		);
		// 30 days ago → old
		expect(computeSavedBand(new Date("2026-03-30").getTime(), now)).toBe("old");
	});

	test("computePublishedBand — fresh/recent/old/unknown", () => {
		const now = new Date("2026-04-29");
		expect(computePublishedBand("2026-04-20", now)).toBe("fresh");
		expect(computePublishedBand("2026-04-01", now)).toBe("recent");
		expect(computePublishedBand("2026-02-01", now)).toBe("old");
		expect(computePublishedBand(undefined, now)).toBe("unknown");
	});

	test("computeReadingBucket — matches index.base formulas", () => {
		expect(computeReadingBucket("new", "fresh")).toBe("🔥 Fresh catch");
		expect(computeReadingBucket("old", "recent")).toBe(
			"✅ Still worth reading",
		);
		expect(computeReadingBucket("old", "old")).toBe("🧊 Probably stale");
		expect(computeReadingBucket("recent", "fresh")).toBe("📚 Active backlog");
		expect(computeReadingBucket("new", "unknown")).toBe("❓ Missing published");
	});

	test("computeReadingScore — unread vs read", () => {
		// Unread, new saved, fresh published → 0 + 30 + 30 = 60
		expect(computeReadingScore(false, "new", "fresh")).toBe(60);
		// Read, new saved, fresh published → -100 + 30 + 30 = -40
		expect(computeReadingScore(true, "new", "fresh")).toBe(-40);
		// Unread, old saved, unknown published → 0 + 10 + 0 = 10
		expect(computeReadingScore(false, "old", "unknown")).toBe(10);
	});
});

describe("recommendations — recommendArticles", () => {
	test("returns unread articles from test vault", () => {
		const recs = recommendArticles(10);
		// Test vault has foo.md (reading_intent: keeper, no reading_completed)
		// and bar.md (no reading_completed). Both are unread.
		// sneak.md is a symlink and should be excluded.
		expect(recs.length).toBe(2);
		const filenames = recs.map((r) => r.filename);
		expect(filenames).toContain("foo.md");
		expect(filenames).toContain("bar.md");
		expect(filenames).not.toContain("sneak.md");
	});

	test("results are sorted by score DESC, then filename ASC", () => {
		const recs = recommendArticles(10);
		// Both files have the same mtime (just created) and no published
		// date, so scores should be equal. Tie-break is filename ASC.
		expect(recs[0]?.filename).toBe("bar.md");
		expect(recs[1]?.filename).toBe("foo.md");
	});

	test("limit caps the result count", () => {
		const recs = recommendArticles(1);
		expect(recs.length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// `/article` command tests — each case has a distinct shape (throw vs
// prompt vs prompt-with-content), so they stay as separate test blocks.
// ---------------------------------------------------------------------------

describe("reader /article command", () => {
	const articleCommand = (readerAgent.commands ?? []).find(
		(c) => c.name === "article",
	);
	if (!articleCommand) {
		throw new Error(
			"readerAgent.commands must include `/article` — declared in source",
		);
	}

	/** Build a minimal `AgentCommandHelpers` bag for testing. */
	function makeHelpers(overrides?: {
		prompt?: (text: string) => Promise<void>;
		pickFromList?: (params: {
			title: string;
			options: { title: string; value: string; description?: string }[];
		}) => Promise<string | undefined>;
		displayMessage?: (text: string) => void;
	}) {
		return {
			prompt: overrides?.prompt ?? (async () => {}),
			pickFromList: overrides?.pickFromList,
			displayMessage: overrides?.displayMessage,
		};
	}

	test("command is declared", () => {
		expect(articleCommand).toBeDefined();
	});

	test("foo.md — prompts with path + content", async () => {
		let promptCalledWith: string | null = null;
		const helpers = makeHelpers({
			prompt: async (text: string) => {
				promptCalledWith = text;
			},
		});
		await articleCommand.execute("foo.md", helpers);
		expect(promptCalledWith).not.toBeNull();
		// Narrow the type for subsequent assertions — we've just verified non-null.
		const text = promptCalledWith as unknown as string;
		expect(text).toContain(`${VAULT}/010 RAW/013 Articles/foo.md`);
		expect(text).toContain("Body paragraph.");
	});

	test("missing.md — throws 'Article not found'", async () => {
		await expect(
			articleCommand.execute("missing.md", makeHelpers()),
		).rejects.toThrow(/not found/i);
	});

	test("../outside.md — throws (escape attempt)", async () => {
		await expect(
			articleCommand.execute("../outside.md", makeHelpers()),
		).rejects.toThrow(/not a file inside|not found|not a regular file/i);
	});

	test("bare /article — calls pickFromList with recommendations", async () => {
		let pickerOptions: { title: string; value: string }[] = [];
		const helpers = makeHelpers({
			pickFromList: async (params) => {
				pickerOptions = params.options;
				return undefined; // simulate cancel
			},
		});
		await articleCommand.execute("", helpers);
		// The picker should have been opened with at least one option.
		// (test vault has foo.md and bar.md unread — no reading_completed)
		expect(pickerOptions.length).toBeGreaterThan(0);
	});

	test("bare /article — selecting an article prompts with content", async () => {
		let promptCalledWith: string | null = null;
		const helpers = makeHelpers({
			prompt: async (text: string) => {
				promptCalledWith = text;
			},
			pickFromList: async () => "bar.md",
		});
		await articleCommand.execute("", helpers);
		expect(promptCalledWith).not.toBeNull();
		const text = promptCalledWith as unknown as string;
		expect(text).toContain("bar.md");
		expect(text).toContain("Another article body.");
	});

	test("bare /article — cancel returns without prompting", async () => {
		let promptCalled = false;
		const helpers = makeHelpers({
			prompt: async () => {
				promptCalled = true;
			},
			pickFromList: async () => undefined, // simulate ESC
		});
		await articleCommand.execute("", helpers);
		expect(promptCalled).toBe(false);
	});

	test("whitespace-only args — opens picker (bare case)", async () => {
		let pickerOpened = false;
		const helpers = makeHelpers({
			pickFromList: async () => {
				pickerOpened = true;
				return undefined;
			},
		});
		await articleCommand.execute("   ", helpers);
		expect(pickerOpened).toBe(true);
	});

	test("sneak.md (symlink) — throws (lstat reject)", async () => {
		await expect(
			articleCommand.execute("sneak.md", makeHelpers()),
		).rejects.toThrow(/symlink/i);
	});
});
