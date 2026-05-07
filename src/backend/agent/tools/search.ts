/**
 * Generic article-directory search tools.
 *
 * Two agent-tool factories share one scanner helper:
 *
 * - `makeSearchTool({ dir, name, description })` — filter-based search
 *   over a directory of markdown files. Matches against YAML
 *   frontmatter values (`filter.frontmatter`, case-insensitive
 *   substring per key, AND across keys) and/or body content
 *   (`filter.content`, case-insensitive substring). Returns
 *   `{ filename, frontmatter?, snippets? }[]` — `frontmatter` only
 *   when the frontmatter filter was used; `snippets` only when the
 *   content filter was used.
 *
 * - `makeListKeysTool({ dir, name, description })` — surface the
 *   frontmatter keys actually present in the directory's articles
 *   so the LLM can name real fields when building a `search` call.
 *   Returns `{ total, keys: [{ name, sample }] }` — no type
 *   inference, no frequency count, just key + one representative
 *   sample value.
 *
 * Both factories take an explicit `name` + `description` so agents
 * pick their own tool identity (reader uses `"search"` + `"list_keys"`
 * scoped to ARTICLES_DIR; a future notes agent could use
 * `"search_notes"` + `"list_note_keys"` scoped to NOTES_DIR without
 * collision). No `cwd` inference, no directory-basename magic.
 *
 * Implementation posture (intentionally simple):
 *
 * - Synchronous read-all on every tool call. No in-memory cache, no
 *   mtime invalidation, no disk index. Fine for vault sizes in the
 *   low hundreds of articles. If profiling ever shows scan time is
 *   user-visible, add a session-scoped cache — tracked under Known
 *   Issues when that happens.
 * - Skips leading-dot entries, `node_modules/`, and symlinks
 *   (matches `listVaultFiles` in `src/tui/util/vault-files.ts`).
 * - Only `.md` / `.markdown` files — `.txt` isn't frontmatter-bearing
 *   in the corpus, so including it would dilute `list_keys` output.
 * - Corrupt frontmatter on a specific file → skip that file; don't
 *   throw (one malformed export shouldn't take down search).
 *
 * No permission baseline — both tools only *read* from a directory
 * the agent already has `read` access to via the vault baseline, and
 * the `dir` arg is fixed at factory time (not user-controllable).
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type FrontmatterValue, parseFrontmatter } from "@bridge/frontmatter";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";

const ALLOWED_EXTENSIONS = new Set([".md", ".markdown"]);
const IGNORED_DIRS = new Set(["node_modules"]);

// ---------------------------------------------------------------------------
// Shared scanner. Returns one entry per markdown file under `dir` along with
// parsed frontmatter + body. Both tools reuse this; neither needs to cache
// intermediate state.
// ---------------------------------------------------------------------------

interface ScannedArticle {
	/** Absolute filesystem path. Used internally by callers needing disk reads. */
	absPath: string;
	/** Path relative to the scanned `dir`, forward-slash normalized. */
	relPath: string;
	/** mtime in ms since epoch, captured during scan. 0 on stat failure. */
	mtime: number;
	frontmatter: Record<string, FrontmatterValue>;
	body: string;
}

function scanDirectory(dir: string): ScannedArticle[] {
	const out: ScannedArticle[] = [];
	walk(dir, dir, out);
	return out;
}

function walk(root: string, current: string, out: ScannedArticle[]): void {
	let entries: string[];
	try {
		entries = readdirSync(current);
	} catch {
		return;
	}
	// Sort entries so traversal order is deterministic across
	// filesystems. `readdirSync` order is filesystem-dependent on
	// Linux / macOS, and downstream sorts in `search` / `list_keys`
	// assume stable input; without this, same-mtime siblings would
	// swap positions across test runs on different machines.
	entries.sort();
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		if (IGNORED_DIRS.has(entry)) continue;
		const abs = join(current, entry);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(abs);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			walk(root, abs, out);
			continue;
		}
		if (!stat.isFile()) continue;
		const dot = entry.lastIndexOf(".");
		if (dot === -1) continue;
		if (!ALLOWED_EXTENSIONS.has(entry.slice(dot).toLowerCase())) continue;

		let text: string;
		try {
			text = readFileSync(abs, "utf-8");
		} catch {
			continue;
		}
		// Corrupt frontmatter just surfaces as an empty `fields` record —
		// `parseFrontmatter` returns `{ fields: {}, body: input }` on any
		// malformed shape, which is what we want: the file still appears
		// in content-only searches but matches no frontmatter filter.
		const { fields, body } = parseFrontmatter(text);
		out.push({
			absPath: abs,
			relPath: normalizeSep(relative(root, abs)),
			mtime: stat.mtimeMs,
			frontmatter: fields,
			body,
		});
	}
}

function normalizeSep(p: string): string {
	return p.includes("\\") ? p.replace(/\\/g, "/") : p;
}

// ---------------------------------------------------------------------------
// search — filter + snippet
// ---------------------------------------------------------------------------

const searchSchema = Type.Object({
	filter: Type.Optional(
		Type.Object({
			frontmatter: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description:
						"Match articles whose frontmatter contains the given key/value pairs. Values are substrings (case-insensitive). Multiple keys are AND-joined. For list-valued keys (e.g. tags, authors), any element containing the substring matches.",
				}),
			),
			content: Type.Optional(
				Type.String({
					description:
						"Substring to search for in the article body (case-insensitive). Matching articles return one snippet per match, up to 3 per article.",
				}),
			),
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 25,
			description:
				"Maximum number of articles to return. Default 10, hard cap 25.",
		}),
	),
});

export type SearchInput = Static<typeof searchSchema>;

export interface SearchHit {
	/** Directory-relative article path. */
	filename: string;
	/** Full parsed frontmatter — present iff `filter.frontmatter` was supplied. */
	frontmatter?: Record<string, FrontmatterValue>;
	/** Content snippets — present iff `filter.content` was supplied. */
	snippets?: string[];
}

interface SnippetMatch {
	startWord: number;
	endWord: number;
}

const DEFAULT_LIMIT = 10;
const HARD_CAP = 25;
const MAX_SNIPPETS_PER_ARTICLE = 3;
const SNIPPET_WORDS_BEFORE = 20;
const SNIPPET_WORDS_AFTER = 20;
const SNIPPET_WORDS_MAX = 50;

/**
 * Case-insensitive substring match for a frontmatter filter KV against one
 * article's parsed frontmatter. Arrays match if any element contains the
 * substring. Missing keys fail the filter.
 */
function matchesFrontmatterFilter(
	articleFm: Record<string, FrontmatterValue>,
	filter: Record<string, string>,
): boolean {
	for (const [key, needle] of Object.entries(filter)) {
		// Skip empty-string filter values — `"".includes("")` is always
		// true, which would otherwise let an LLM-supplied `{ author: "" }`
		// match every article with *any* author. Typebox validates the
		// value as `Type.String()` (non-empty isn't a schema constraint),
		// so we guard at runtime.
		if (needle.length === 0) continue;
		const haystack = articleFm[key];
		if (haystack === undefined) return false;
		const needleLower = needle.toLowerCase();
		if (Array.isArray(haystack)) {
			const hit = haystack.some((v) => v.toLowerCase().includes(needleLower));
			if (!hit) return false;
		} else if (typeof haystack === "string") {
			if (!haystack.toLowerCase().includes(needleLower)) return false;
		} else {
			return false;
		}
	}
	return true;
}

/**
 * Build up to N windowed snippets around `needle` occurrences in `body`.
 * Windows are word-aligned (~20 before / ~20 after, capped at 50 total).
 * Overlapping or adjacent windows are merged so one large match-cluster
 * doesn't crowd out match-clusters elsewhere in the article.
 *
 * Returns the rendered snippet strings (already joined with spaces); the
 * caller tracks only the count of snippets, not the underlying match
 * total — the LLM can widen the filter if coverage feels thin.
 */
function buildSnippets(body: string, needle: string): string[] {
	if (!needle) return [];
	const needleLower = needle.toLowerCase();
	const bodyLower = body.toLowerCase();

	// Tokenize the body into words keeping their original character
	// positions so snippet bounds can be reconstructed against the
	// original body text (not a lossy re-split).
	const words: { text: string; start: number; end: number }[] = [];
	const wordRe = /\S+/g;
	let wm: RegExpExecArray | null = wordRe.exec(body);
	while (wm !== null) {
		words.push({ text: wm[0], start: wm.index, end: wm.index + wm[0].length });
		wm = wordRe.exec(body);
	}
	if (words.length === 0) return [];

	// Map each match's char index to the word index it falls in. A
	// match inside whitespace (impossible for non-empty needles that
	// contain non-space chars, but guarded) is mapped to the next word.
	const matchWordIdxs: number[] = [];
	let searchFrom = 0;
	while (searchFrom < bodyLower.length) {
		const hit = bodyLower.indexOf(needleLower, searchFrom);
		if (hit === -1) break;
		// Find the word containing `hit`. Words are sorted, so linear
		// walk with a moving cursor is O(n+m) total across the outer
		// loop — cheap for body sizes in practice.
		const wordIdx = findWordIndex(words, hit);
		if (wordIdx !== -1) matchWordIdxs.push(wordIdx);
		searchFrom = hit + Math.max(needleLower.length, 1);
	}
	if (matchWordIdxs.length === 0) return [];

	// Expand each match into a window and merge overlapping windows.
	// Sort + sweep gives us deduplicated coverage regions.
	const windows: SnippetMatch[] = matchWordIdxs
		.map((w) => ({
			startWord: Math.max(0, w - SNIPPET_WORDS_BEFORE),
			endWord: Math.min(words.length - 1, w + SNIPPET_WORDS_AFTER),
		}))
		.sort((a, b) => a.startWord - b.startWord);

	const merged: SnippetMatch[] = [];
	for (const w of windows) {
		const last = merged[merged.length - 1];
		if (last && w.startWord <= last.endWord + 1) {
			last.endWord = Math.max(last.endWord, w.endWord);
		} else {
			merged.push({ ...w });
		}
	}

	// Clamp any merged window that grew past SNIPPET_WORDS_MAX. This
	// happens when several near-adjacent matches merge into a window
	// that would otherwise balloon. Truncate symmetrically around the
	// midpoint so context on both sides is preserved.
	for (const w of merged) {
		const span = w.endWord - w.startWord + 1;
		if (span > SNIPPET_WORDS_MAX) {
			const excess = span - SNIPPET_WORDS_MAX;
			const leftTrim = Math.floor(excess / 2);
			const rightTrim = excess - leftTrim;
			w.startWord += leftTrim;
			w.endWord -= rightTrim;
		}
	}

	// Cap total snippets per article after merging. Post-merge cap is
	// the right moment: we want the cap to count "distinct regions of
	// the article," not raw match positions.
	const capped = merged.slice(0, MAX_SNIPPETS_PER_ARTICLE);

	return capped.flatMap((w) => {
		const startWord = words[w.startWord];
		const endWord = words[w.endWord];
		if (!startWord || !endWord) return [];
		return [
			body.slice(startWord.start, endWord.end).replace(/\s+/g, " ").trim(),
		];
	});
}

function findWordIndex(
	words: { start: number; end: number }[],
	charIdx: number,
): number {
	// Binary search; words are sorted by `start`.
	let lo = 0;
	let hi = words.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const w = words[mid];
		if (!w) break;
		if (charIdx < w.start) hi = mid - 1;
		else if (charIdx > w.end) lo = mid + 1;
		else return mid;
	}
	// `charIdx` is between words — map to the next word after it.
	return lo < words.length ? lo : -1;
}

export interface SearchToolOptions {
	/** Absolute path to the directory scanned on every tool call. */
	dir: string;
	/** Tool name the LLM sees (e.g. `"search"`). */
	name: string;
	/**
	 * Tool description the LLM sees. Should teach the call sequence
	 * (when to combine frontmatter + content filters, when to pair
	 * with a `list_keys` call first).
	 */
	description: string;
}

export function makeSearchTool(
	opts: SearchToolOptions,
): AgentTool<typeof searchSchema, SearchHit[]> {
	const { dir, name, description } = opts;
	return {
		name,
		label: name,
		description,
		parameters: searchSchema,
		async execute(
			_callId: string,
			params: SearchInput,
		): Promise<AgentToolResult<SearchHit[]>> {
			const fmFilter = params.filter?.frontmatter;
			const contentFilter = params.filter?.content;
			const usedFmFilter = !!fmFilter && Object.keys(fmFilter).length > 0;
			const usedContentFilter = !!contentFilter && contentFilter.length > 0;
			const limit = Math.min(params.limit ?? DEFAULT_LIMIT, HARD_CAP);

			const articles = scanDirectory(dir);

			let filtered: ScannedArticle[] = articles;
			if (fmFilter && usedFmFilter) {
				filtered = filtered.filter((a) =>
					matchesFrontmatterFilter(a.frontmatter, fmFilter),
				);
			}

			// Track snippets alongside the article so we can drop
			// zero-match articles when a content filter is active.
			const withSnippets = filtered.map((a) => {
				if (!contentFilter || !usedContentFilter) {
					return { article: a, snippets: undefined };
				}
				const snippets = buildSnippets(a.body, contentFilter);
				return { article: a, snippets };
			});

			const matched = usedContentFilter
				? withSnippets.filter((x) => x.snippets && x.snippets.length > 0)
				: withSnippets;

			// Sort ALL results deterministically (filtered OR not).
			// `readdirSync` order is filesystem-dependent, and a
			// cross-platform `slice(0, limit)` would otherwise drop
			// different articles on different machines. mtime-desc
			// with relPath tiebreak gives "most recently modified first"
			// across every call path — matches the no-filter "list
			// recent" semantic and keeps filtered queries stable across
			// platforms. mtime is captured once per article during
			// scan (see `ScannedArticle.mtime`), so this comparator
			// is O(1) per call.
			const ordered = [...matched].sort((a, b) => {
				if (b.article.mtime !== a.article.mtime) {
					return b.article.mtime - a.article.mtime;
				}
				return a.article.relPath.localeCompare(b.article.relPath);
			});

			const hits: SearchHit[] = ordered.slice(0, limit).map((x) => {
				const hit: SearchHit = { filename: x.article.relPath };
				if (usedFmFilter) hit.frontmatter = x.article.frontmatter;
				if (usedContentFilter) hit.snippets = x.snippets;
				return hit;
			});

			const summary =
				hits.length === 0
					? "No matching articles."
					: `Found ${hits.length} article${hits.length === 1 ? "" : "s"}.`;

			return {
				content: [
					{
						type: "text",
						text:
							hits.length === 0
								? summary
								: `${summary}\n\n${JSON.stringify(hits, null, 2)}`,
					},
				],
				details: hits,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// list_keys — enumerate observed frontmatter keys with one sample each
// ---------------------------------------------------------------------------

const listKeysSchema = Type.Object({});

export type ListKeysInput = Static<typeof listKeysSchema>;

export interface ListKeysKey {
	/** Frontmatter key name as written in the articles. */
	name: string;
	/**
	 * One representative sample value. String for scalars, first
	 * element for arrays. Deterministic across runs: taken from the
	 * lexicographically-first article that sets the key.
	 */
	sample: string;
}

export interface ListKeysResult {
	/** Total markdown files scanned (including files with no frontmatter). */
	total: number;
	/** Observed keys, sorted alphabetically for stable output. */
	keys: ListKeysKey[];
}

export interface ListKeysToolOptions {
	dir: string;
	name: string;
	description: string;
}

export function makeListKeysTool(
	opts: ListKeysToolOptions,
): AgentTool<typeof listKeysSchema, ListKeysResult> {
	const { dir, name, description } = opts;
	return {
		name,
		label: name,
		description,
		parameters: listKeysSchema,
		async execute(
			_callId: string,
			_params: ListKeysInput,
		): Promise<AgentToolResult<ListKeysResult>> {
			const articles = scanDirectory(dir);
			// Iterate in sorted order so "first article to set key X"
			// is deterministic (lexicographic on relPath).
			const sorted = [...articles].sort((a, b) =>
				a.relPath.localeCompare(b.relPath),
			);
			const samples: Record<string, string> = {};
			for (const a of sorted) {
				for (const [key, value] of Object.entries(a.frontmatter)) {
					if (samples[key] !== undefined) continue;
					const sample = Array.isArray(value) ? (value[0] ?? "") : value;
					if (typeof sample !== "string" || sample.length === 0) continue;
					samples[key] = sample;
				}
			}
			const keys: ListKeysKey[] = Object.keys(samples)
				.sort()
				.flatMap((k) => {
					const sample = samples[k];
					return sample !== undefined ? [{ name: k, sample }] : [];
				});

			const result: ListKeysResult = { total: articles.length, keys };
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
				details: result,
			};
		},
	};
}
