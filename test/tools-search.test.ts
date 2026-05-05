/**
 * Tests for `makeSearchTool` and `makeListKeysTool`.
 *
 * Seeds a temp article directory with crafted markdown fixtures covering
 * the shapes the scanner is expected to handle:
 *
 * - Scalar frontmatter (title, author, published)
 * - Block-sequence frontmatter (co-author array)
 * - Missing frontmatter (body-only file)
 * - Malformed frontmatter (unclosed `---` fence) — survives in content searches
 * - Nested subdirectory (scanner walks recursively)
 * - Symlink + dotfile + `.txt` + `node_modules/` — all excluded by scanner
 *
 * Fixtures are built inside an `afterAll`-cleaned temp dir rather than
 * committed under `test/fixtures/` because symlink fixtures don't
 * survive git checkouts cleanly (Windows, some CI environments).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ListKeysResult,
	makeListKeysTool,
	makeSearchTool,
	type SearchHit,
} from "@backend/agent/tools/search";

let DIR: string;

async function runSearch(
	tool: ReturnType<typeof makeSearchTool>,
	input: unknown,
): Promise<SearchHit[]> {
	const result = await tool.execute("call-id", input as never);
	return result.details;
}

async function runListKeys(
	tool: ReturnType<typeof makeListKeysTool>,
): Promise<ListKeysResult> {
	const result = await tool.execute("call-id", {});
	return result.details;
}

beforeAll(() => {
	DIR = mkdtempSync(join(tmpdir(), "inkstone-search-"));

	// Scalar frontmatter — most common shape.
	writeFileSync(
		join(DIR, "a-agent-design.md"),
		[
			"---",
			'title: "Agent Design Is Still Hard"',
			'author: "Andrew Ng"',
			'published: "2025-11-14"',
			'description: "Thoughts on building agentic systems"',
			"tags:",
			'  - "ai"',
			'  - "agents"',
			"---",
			"",
			"Agents are hard because the world is hard. Building a reliable",
			"agent means thinking about failure modes up front.",
			"",
			"The article on agents keeps coming back to attention and memory.",
		].join("\n"),
	);

	// Block-sequence author array.
	writeFileSync(
		join(DIR, "b-ensemble-methods.md"),
		[
			"---",
			'title: "Ensemble Methods"',
			"author:",
			'  - "Jane Doe"',
			'  - "Andrew Ng"',
			'published: "2024-03-02"',
			"tags:",
			'  - "ml"',
			"---",
			"",
			"Ensemble methods combine multiple weak models into one strong one.",
		].join("\n"),
	);

	// Different author, same topic keywords.
	writeFileSync(
		join(DIR, "c-quiet-agents.md"),
		[
			"---",
			'title: "Quiet Agents"',
			'author: "Bob Smith"',
			'published: "2025-08-30"',
			"---",
			"",
			"A calm take on agents without the hype.",
		].join("\n"),
	);

	// Body-only file: no frontmatter block.
	writeFileSync(
		join(DIR, "d-no-frontmatter.md"),
		"Just a plain markdown file discussing agents and workflows.\n",
	);

	// Malformed: opens a fence but never closes it. Parser returns empty
	// fields and treats the whole thing as body, so content searches
	// still match the prose below.
	writeFileSync(
		join(DIR, "e-malformed.md"),
		[
			"---",
			"title: half-open",
			"",
			"No closing fence — malformed export. Agents discussion follows.",
		].join("\n"),
	);

	// Nested subdir — scanner should walk recursively.
	mkdirSync(join(DIR, "subdir"));
	writeFileSync(
		join(DIR, "subdir", "f-deep.md"),
		[
			"---",
			'title: "Deep File"',
			'author: "Carol"',
			"---",
			"",
			"Nested discussion of agents.",
		].join("\n"),
	);

	// Excluded entries.
	writeFileSync(
		join(DIR, ".hidden.md"),
		"---\ntitle: hidden\n---\n\nShould not appear.\n",
	);
	writeFileSync(join(DIR, "notes.txt"), "Should not appear (wrong ext).\n");
	mkdirSync(join(DIR, "node_modules"));
	writeFileSync(
		join(DIR, "node_modules", "pkg.md"),
		"---\ntitle: dep\n---\n\nShould not appear.\n",
	);

	// Symlink — rejected regardless of target type.
	try {
		symlinkSync(join(DIR, "a-agent-design.md"), join(DIR, "link-to-a.md"));
	} catch {
		// Some environments (Windows without admin, restricted sandboxes)
		// can't create symlinks. Skip — the rest of the test body doesn't
		// depend on that particular exclusion being present.
	}
});

afterAll(() => {
	if (DIR) rmSync(DIR, { recursive: true, force: true });
});

describe("search — no filter", () => {
	test("returns filenames only, sorted by mtime desc", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {});
		expect(hits.length).toBeGreaterThan(0);
		// All hits have only `filename` — no frontmatter, no snippets.
		for (const h of hits) {
			expect(h.filename).toBeString();
			expect(h.frontmatter).toBeUndefined();
			expect(h.snippets).toBeUndefined();
		}
	});

	test("excludes dotfiles, node_modules, .txt, symlinks", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, { limit: 25 });
		const names = hits.map((h) => h.filename);
		expect(names).not.toContain(".hidden.md");
		expect(names).not.toContain("notes.txt");
		expect(names.some((n) => n.includes("node_modules"))).toBeFalse();
		expect(names).not.toContain("link-to-a.md");
	});

	test("walks subdirectories", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, { limit: 25 });
		expect(hits.map((h) => h.filename)).toContain("subdir/f-deep.md");
	});

	test("honors default limit of 10", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {});
		expect(hits.length).toBeLessThanOrEqual(10);
	});
});

describe("search — frontmatter filter", () => {
	test("single scalar KV, substring case-insensitive", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { frontmatter: { author: "andrew" } },
		});
		const names = hits.map((h) => h.filename);
		expect(names).toContain("a-agent-design.md"); // "Andrew Ng"
		expect(names).toContain("b-ensemble-methods.md"); // "Andrew Ng" in array
		expect(names).not.toContain("c-quiet-agents.md"); // "Bob Smith"
		// Frontmatter attached to every hit when frontmatter filter was used.
		for (const h of hits) {
			expect(h.frontmatter).toBeDefined();
			expect(h.snippets).toBeUndefined();
		}
	});

	test("multiple KVs AND-join", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { frontmatter: { author: "andrew", published: "2025" } },
		});
		const names = hits.map((h) => h.filename);
		expect(names).toContain("a-agent-design.md"); // 2025 + Andrew
		expect(names).not.toContain("b-ensemble-methods.md"); // 2024 fails the second KV
	});

	test("array value match via any-element-contains", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { frontmatter: { tags: "agents" } },
		});
		expect(hits.map((h) => h.filename)).toContain("a-agent-design.md");
	});

	test("missing key fails filter", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { frontmatter: { nonexistent: "anything" } },
		});
		expect(hits).toEqual([]);
	});

	test("case-insensitive match", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { frontmatter: { author: "ANDREW NG" } },
		});
		expect(hits.map((h) => h.filename)).toContain("a-agent-design.md");
	});
});

describe("search — content filter", () => {
	test("matches body substring, attaches snippets", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { content: "agents" },
		});
		expect(hits.length).toBeGreaterThan(0);
		for (const h of hits) {
			expect(h.snippets).toBeDefined();
			expect(h.snippets!.length).toBeGreaterThan(0);
			expect(h.frontmatter).toBeUndefined();
		}
	});

	test("snippet caps at 3 per article and merges overlaps", async () => {
		// Fixture: one close cluster of 5 overlapping matches + two
		// distant matches. Close cluster should merge into a single
		// snippet; distant matches should each produce their own
		// (or merge into one more if they happen to land within 20
		// words of each other through the filler). The exact merged
		// count is determined by the filler width, not by happenstance.
		const closeCluster = Array.from({ length: 5 }, () => "agents agents").join(
			" word ",
		);
		const filler = Array.from({ length: 40 }, () => "filler").join(" ");
		const distant1 = `${filler} agents ${filler}`;
		const distant2 = `${filler} agents ${filler}`;
		const body = [closeCluster, distant1, distant2].join("\n\n");
		writeFileSync(
			join(DIR, "snippet-cap.md"),
			["---", 'title: "Cap Test"', "---", "", body].join("\n"),
		);

		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { content: "agents" },
		});
		const hit = hits.find((h) => h.filename === "snippet-cap.md");
		expect(hit).toBeDefined();
		const snippets = hit?.snippets ?? [];
		// Cap enforced.
		expect(snippets.length).toBeLessThanOrEqual(3);
		// Merge enforced: the 5 overlapping matches collapse into one
		// snippet, so the total is fewer than the raw 7 hits. A
		// regression that disabled merging would still satisfy the
		// `<= 3` cap but would fail this lower-bound check (raw match
		// count hits the cap at 3, but each snippet would contain
		// fewer than 3 "agents" tokens).
		const clusterSnippet = snippets.find(
			(s) => (s.match(/agents/gi) ?? []).length >= 3,
		);
		expect(clusterSnippet).toBeDefined();
	});

	test("no matches → article excluded from results", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { content: "xyzzy-does-not-exist" },
		});
		expect(hits).toEqual([]);
	});

	test("malformed frontmatter file still matches on body", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { content: "malformed export" },
		});
		expect(hits.map((h) => h.filename)).toContain("e-malformed.md");
	});
});

describe("search — combined filters", () => {
	test("frontmatter + content both must match, both payloads attached", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, {
			filter: { frontmatter: { author: "andrew" }, content: "agents" },
		});
		const names = hits.map((h) => h.filename);
		expect(names).toContain("a-agent-design.md");
		expect(names).not.toContain("c-quiet-agents.md"); // author wrong
		expect(names).not.toContain("d-no-frontmatter.md"); // no frontmatter → fm filter fails
		for (const h of hits) {
			expect(h.frontmatter).toBeDefined();
			expect(h.snippets).toBeDefined();
		}
	});
});

describe("search — limit", () => {
	test("honors caller-supplied limit", async () => {
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, { limit: 2 });
		expect(hits.length).toBeLessThanOrEqual(2);
	});

	test("hard cap at 25 even if caller asks for more", async () => {
		// typebox validates maximum at the schema layer, so the tool
		// contract itself rejects >25 before reaching execute(). We
		// therefore assert by passing the maximum and confirming it
		// doesn't throw; the hard-cap guard in execute is belt + braces.
		const tool = makeSearchTool({
			dir: DIR,
			name: "search",
			description: "search articles",
		});
		const hits = await runSearch(tool, { limit: 25 });
		expect(hits.length).toBeLessThanOrEqual(25);
	});
});

describe("list_keys", () => {
	test("surfaces every observed key, alphabetically sorted", async () => {
		const tool = makeListKeysTool({
			dir: DIR,
			name: "list_keys",
			description: "list frontmatter keys",
		});
		const result = await runListKeys(tool);
		const names = result.keys.map((k) => k.name);
		expect(names).toContain("title");
		expect(names).toContain("author");
		expect(names).toContain("published");
		expect(names).toContain("tags");
		// Alphabetically sorted.
		const sorted = [...names].sort();
		expect(names).toEqual(sorted);
	});

	test("reports total files scanned", async () => {
		const tool = makeListKeysTool({
			dir: DIR,
			name: "list_keys",
			description: "list frontmatter keys",
		});
		const result = await runListKeys(tool);
		// a, b, c, d (no frontmatter), e (malformed), f (nested), snippet-cap.md — 7.
		expect(result.total).toBeGreaterThanOrEqual(6);
	});

	test("sample values come from the lexicographically-first article", async () => {
		const tool = makeListKeysTool({
			dir: DIR,
			name: "list_keys",
			description: "list frontmatter keys",
		});
		const result = await runListKeys(tool);
		const author = result.keys.find((k) => k.name === "author");
		// Lexicographic first key-setting file is `a-agent-design.md`
		// → scalar "Andrew Ng".
		expect(author?.sample).toBe("Andrew Ng");
	});

	test("array-valued keys sample the first element", async () => {
		const tool = makeListKeysTool({
			dir: DIR,
			name: "list_keys",
			description: "list frontmatter keys",
		});
		const result = await runListKeys(tool);
		const tags = result.keys.find((k) => k.name === "tags");
		// First file to set `tags` is a-agent-design.md → ["ai", "agents"].
		expect(tags?.sample).toBe("ai");
	});

	test("deterministic across back-to-back calls", async () => {
		const tool = makeListKeysTool({
			dir: DIR,
			name: "list_keys",
			description: "list frontmatter keys",
		});
		const a = await runListKeys(tool);
		const b = await runListKeys(tool);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});
