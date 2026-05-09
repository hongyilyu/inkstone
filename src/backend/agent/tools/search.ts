/**
 * Generic search + list-keys tool factories for a directory of
 * markdown-with-frontmatter files.
 *
 * - `makeSearchTool({ dir, name, description })` — filter by
 *   frontmatter KV (substring, AND) and/or body content (substring).
 *   Returns `{ filename, frontmatter?, snippets? }[]`, attaching
 *   `frontmatter` iff the frontmatter filter was used and `snippets`
 *   iff the content filter was used.
 * - `makeListKeysTool({ dir, name, description })` — enumerate
 *   observed frontmatter keys with one deterministic sample per key.
 *
 * Implementation posture: sync read-all per call, no cache, `.md` /
 * `.markdown` only, corrupt frontmatter surfaces as empty fields. Empty
 * `baseline: []` declared on the returned tool — `dir` is fixed at
 * factory time and not user-controllable, so no path-keyed rules apply.
 *
 * Factories take an explicit `name` + `description` so callers pick
 * their own identity (reader: `"search"` + `"list_keys"` scoped to
 * ARTICLES_DIR; a future notes agent could scope to NOTES_DIR).
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type FrontmatterValue, parseFrontmatter } from "@bridge/frontmatter";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { registerBaselineFree } from "../permissions";
import type { InkstoneTool } from "../types";

const ALLOWED_EXTENSIONS = new Set([".md", ".markdown"]);
const IGNORED_DIRS = new Set(["node_modules"]);

// Shared scanner shared by both factories.

interface ScannedFile {
	absPath: string;
	/** Forward-slash normalized, relative to the scanned `dir`. */
	relPath: string;
	mtime: number;
	frontmatter: Record<string, FrontmatterValue>;
	body: string;
}

function scanDirectory(dir: string): ScannedFile[] {
	const out: ScannedFile[] = [];
	walk(dir, dir, out);
	return out;
}

function walk(root: string, current: string, out: ScannedFile[]): void {
	let entries: string[];
	try {
		entries = readdirSync(current);
	} catch {
		return;
	}
	// Sort so downstream mtime-tiebreak / key-sample order is
	// filesystem-independent.
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
		// Corrupt frontmatter → empty fields; file still searchable on body.
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

// search — filter + snippet ───────────────────────────────────────────

const searchSchema = Type.Object({
	filter: Type.Optional(
		Type.Object({
			frontmatter: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description:
						"Match files whose frontmatter contains the given key/value pairs. Values are substrings (case-insensitive). Multiple keys are AND-joined. For list-valued keys (e.g. tags, authors), any element containing the substring matches.",
				}),
			),
			content: Type.Optional(
				Type.String({
					description:
						"Substring to search for in the file body (case-insensitive). Matching files return one snippet per match, up to 3 per file.",
				}),
			),
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 25,
			description:
				"Maximum number of files to return. Default 10, hard cap 25.",
		}),
	),
});

export type SearchInput = Static<typeof searchSchema>;

export interface SearchHit {
	/** Directory-relative file path. */
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
const MAX_SNIPPETS_PER_FILE = 3;
const SNIPPET_WORDS_BEFORE = 20;
const SNIPPET_WORDS_AFTER = 20;
const SNIPPET_WORDS_MAX = 50;

/**
 * Case-insensitive substring match. Arrays match if any element
 * contains the substring; missing keys fail. Empty-string values
 * skipped (`"".includes("")` would otherwise match every file).
 */
function matchesFrontmatterFilter(
	fm: Record<string, FrontmatterValue>,
	filter: Record<string, string>,
): boolean {
	for (const [key, needle] of Object.entries(filter)) {
		if (needle.length === 0) continue;
		const haystack = fm[key];
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
 * Word-windowed snippets (~20 before / 20 after, hard-capped at 50
 * words per merged region). Overlapping windows merge so one match
 * cluster doesn't crowd out clusters elsewhere in the file. Returns
 * at most `MAX_SNIPPETS_PER_FILE` distinct regions.
 */
function buildSnippets(body: string, needle: string): string[] {
	if (!needle) return [];
	const needleLower = needle.toLowerCase();
	const bodyLower = body.toLowerCase();

	// Tokenize keeping original char positions so the final slice
	// reads from the untouched body.
	const words: { text: string; start: number; end: number }[] = [];
	const wordRe = /\S+/g;
	let wm: RegExpExecArray | null = wordRe.exec(body);
	while (wm !== null) {
		words.push({ text: wm[0], start: wm.index, end: wm.index + wm[0].length });
		wm = wordRe.exec(body);
	}
	if (words.length === 0) return [];

	const matchWordIdxs: number[] = [];
	let searchFrom = 0;
	while (searchFrom < bodyLower.length) {
		const hit = bodyLower.indexOf(needleLower, searchFrom);
		if (hit === -1) break;
		const wordIdx = findWordIndex(words, hit);
		if (wordIdx !== -1) matchWordIdxs.push(wordIdx);
		searchFrom = hit + Math.max(needleLower.length, 1);
	}
	if (matchWordIdxs.length === 0) return [];

	// Expand → sort → merge overlapping windows.
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

	// Trim oversize merged windows symmetrically (preserves context both sides).
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

	// Cap after merging so the cap counts distinct regions, not raw matches.
	const capped = merged.slice(0, MAX_SNIPPETS_PER_FILE);

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
	// Between words → map to the next word after the cursor.
	return lo < words.length ? lo : -1;
}

export interface SearchToolOptions {
	dir: string;
	name: string;
	/** Should teach when to pair with a `list_keys` call first. */
	description: string;
}

export function makeSearchTool(
	opts: SearchToolOptions,
): InkstoneTool<typeof searchSchema, SearchHit[]> {
	const { dir, name, description } = opts;
	registerBaselineFree(
		name,
		"Read-only directory scan; dir is fixed at factory time, not user-controllable.",
	);
	return {
		name,
		label: name,
		description,
		parameters: searchSchema,
		// Read-only directory scan; `dir` is fixed at factory time, not
		// user-controllable. Empty baseline is the explicit "no rules
		// apply" declaration.
		baseline: [],
		async execute(
			_callId: string,
			params: SearchInput,
		): Promise<AgentToolResult<SearchHit[]>> {
			const fmFilter = params.filter?.frontmatter;
			const contentFilter = params.filter?.content;
			const usedFmFilter = !!fmFilter && Object.keys(fmFilter).length > 0;
			const usedContentFilter = !!contentFilter && contentFilter.length > 0;
			const limit = Math.min(params.limit ?? DEFAULT_LIMIT, HARD_CAP);

			const files = scanDirectory(dir);

			let filtered: ScannedFile[] = files;
			if (fmFilter && usedFmFilter) {
				filtered = filtered.filter((f) =>
					matchesFrontmatterFilter(f.frontmatter, fmFilter),
				);
			}

			// Track snippets alongside each file so we can drop
			// zero-match files when a content filter is active.
			const withSnippets = filtered.map((f) => {
				if (!contentFilter || !usedContentFilter) {
					return { file: f, snippets: undefined };
				}
				const snippets = buildSnippets(f.body, contentFilter);
				return { file: f, snippets };
			});

			const matched = usedContentFilter
				? withSnippets.filter((x) => x.snippets && x.snippets.length > 0)
				: withSnippets;

			// Sort deterministically (mtime desc, relPath tiebreak) so
			// `slice(0, limit)` is cross-platform stable.
			const ordered = [...matched].sort((a, b) => {
				if (b.file.mtime !== a.file.mtime) {
					return b.file.mtime - a.file.mtime;
				}
				return a.file.relPath.localeCompare(b.file.relPath);
			});

			const hits: SearchHit[] = ordered.slice(0, limit).map((x) => {
				const hit: SearchHit = { filename: x.file.relPath };
				if (usedFmFilter) hit.frontmatter = x.file.frontmatter;
				if (usedContentFilter) hit.snippets = x.snippets;
				return hit;
			});

			const summary =
				hits.length === 0
					? "No matching files."
					: `Found ${hits.length} file${hits.length === 1 ? "" : "s"}.`;

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

// list_keys — enumerate observed frontmatter keys ────────────────────

const listKeysSchema = Type.Object({});

export type ListKeysInput = Static<typeof listKeysSchema>;

export interface ListKeysKey {
	name: string;
	/** Representative sample — scalar or first array element. Taken
	 * deterministically from the lexicographically-first file that
	 * sets the key. */
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
): InkstoneTool<typeof listKeysSchema, ListKeysResult> {
	const { dir, name, description } = opts;
	registerBaselineFree(
		name,
		"Read-only frontmatter-key enumeration; dir is fixed at factory time.",
	);
	return {
		name,
		label: name,
		description,
		parameters: listKeysSchema,
		// Read-only frontmatter-key enumeration; `dir` is fixed at
		// factory time. Empty baseline is the explicit "no rules apply"
		// declaration.
		baseline: [],
		async execute(
			_callId: string,
			_params: ListKeysInput,
		): Promise<AgentToolResult<ListKeysResult>> {
			const files = scanDirectory(dir);
			// Iterate lexicographically so "first file to set key X" is deterministic.
			const sorted = [...files].sort((a, b) =>
				a.relPath.localeCompare(b.relPath),
			);
			const samples: Record<string, string> = {};
			for (const f of sorted) {
				for (const [key, value] of Object.entries(f.frontmatter)) {
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

			const result: ListKeysResult = { total: files.length, keys };
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
