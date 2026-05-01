/**
 * Vault file lister for the prompt `@` autocomplete.
 *
 * Synchronous recursive walker with a module-local lazy cache — first call
 * (from the user's first `@` trigger in the session) walks `VAULT_DIR`;
 * subsequent calls return the cached list unchanged. No invalidation API
 * for MVP; the cache lives for the process lifetime.
 *
 * Returns vault-relative paths, matching the chip format used by
 * `/article` (`path.relative(VAULT_DIR, absPath)`). Only text file types
 * the LLM can actually consume are included.
 */

import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { VAULT_DIR } from "@backend/agent/constants";

/** File extensions surfaced in the `@` dropdown. */
const ALLOWED_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/**
 * Directory basenames skipped during the walk. Matches Obsidian/Git
 * conventions; leading-dot entries are skipped by the loop regardless,
 * so this set only needs the non-dotted exceptions.
 */
const IGNORED_DIRS = new Set(["node_modules"]);

let cached: string[] | null = null;

export function listVaultFiles(): string[] {
	if (cached !== null) return cached;
	const out: string[] = [];
	walk(VAULT_DIR, out);
	out.sort();
	cached = out;
	return cached;
}

/**
 * Drop the cached file list. Next `listVaultFiles()` call will re-walk.
 * No callers today — reserved for a future "refresh vault index" command
 * or `fs.watch` hook. Exported so that integration lands as a plug-in
 * rather than requiring this module to grow a watcher itself.
 */
export function invalidateVaultFileCache(): void {
	cached = null;
}

function walk(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// Unreadable directory (permissions, race with a delete, etc.) —
		// skip silently rather than surface an error that'd prevent the
		// dropdown from opening at all.
		return;
	}
	for (const entry of entries) {
		// Skip leading-dot entries (`.obsidian`, `.git`, `.trash`, dotfiles)
		// and named exceptions (`node_modules`).
		if (entry.startsWith(".")) continue;
		if (IGNORED_DIRS.has(entry)) continue;

		const abs = join(dir, entry);
		let stat: ReturnType<typeof lstatSync>;
		try {
			// `lstatSync` — NOT `statSync` — so symlinks are identified as
			// symlinks, not followed to their target. `readFileSafe` in
			// `mentions.ts` rejects symlinks at read time; if the scanner
			// followed them here, users could pick a symlinked file from
			// the dropdown and get a "could not read" toast for what looks
			// like a perfectly normal file. Matching `readFileSafe`'s
			// contract keeps the dropdown = "files you can actually send."
			stat = lstatSync(abs);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			walk(abs, out);
			continue;
		}
		if (!stat.isFile()) continue;

		const dot = entry.lastIndexOf(".");
		if (dot === -1) continue;
		const ext = entry.slice(dot).toLowerCase();
		if (!ALLOWED_EXTENSIONS.has(ext)) continue;

		// Store vault-relative paths with forward-slash separators so
		// they match the `/article` chip format and render identically
		// on all platforms. `path.relative` uses the OS separator, so
		// normalize on Windows.
		const rel = relative(VAULT_DIR, abs);
		out.push(sep === "/" ? rel : rel.split(sep).join("/"));
	}
}
