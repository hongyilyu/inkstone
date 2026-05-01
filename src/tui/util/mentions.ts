/**
 * `@` file-mention payload builder.
 *
 * Pure stringification: given a prompt text, a list of in-text mention
 * ranges, and a `readFile` function, produces:
 *   - `llmText`: the text pi-agent-core sends to the LLM, with each
 *     successfully-read mention span replaced by a reader-style
 *     `Path: <path>\n\nContent:\n\n<body>` block (matching the format
 *     `/article` already uses, see `src/backend/agent/agents/reader/index.ts`).
 *     Failed reads collapse to their literal source substring (`@<path>`).
 *   - `displayParts`: the `DisplayPart[]` the user bubble renders —
 *     interleaved `text` / `file` parts for successful mentions; failed
 *     mentions merge into surrounding text parts.
 *   - `failed`: list of vault-relative paths that `readFile` returned
 *     `null` for. Caller decides whether to surface a toast.
 *
 * No I/O, no renderable access. Caller extracts mentions from the
 * renderable's extmarks, passes them sorted by `start` ascending.
 */

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { VAULT_DIR } from "@backend/agent/constants";
import { isInsideDir } from "@backend/agent/permissions";
import type { DisplayPart } from "@bridge/view-model";
import { ALLOWED_VAULT_EXTENSIONS } from "./vault-files";

export interface Mention {
	/** Byte offset in the prompt text where `@` starts. */
	start: number;
	/** Byte offset one past the last char of `@path`. */
	end: number;
	/** Vault-relative path (matches the user-bubble chip format). */
	path: string;
}

export interface MentionPayload {
	/** Text handed to pi-agent-core / the LLM. */
	llmText: string;
	/**
	 * Display parts for the user bubble. `undefined` when there are
	 * zero successful mentions AND no failures — i.e. the plain-text
	 * fast path that `wrappedActions.prompt(text)` handles with a
	 * default `[{type:"text", text}]` shape.
	 */
	displayParts: DisplayPart[] | undefined;
	/** Vault-relative paths where `readFile` returned `null`. */
	failed: string[];
}

/**
 * Build the LLM text + display parts from a prompt text and mention
 * ranges. Mentions must be sorted by `start` ascending; the caller is
 * responsible (extmarks come back in insertion order, not position
 * order, so the sort matters — see `prompt.tsx` handleSubmit).
 */
export function buildMentionPayload(
	text: string,
	mentions: Mention[],
	readFile: (vaultRelPath: string) => string | null,
): MentionPayload {
	if (mentions.length === 0) {
		return { llmText: text, displayParts: undefined, failed: [] };
	}

	const llm: string[] = [];
	const parts: DisplayPart[] = [];
	const failed: string[] = [];
	let cursor = 0;

	const appendText = (s: string) => {
		if (s.length === 0) return;
		const tail = parts[parts.length - 1];
		if (tail && tail.type === "text") {
			tail.text += s;
		} else {
			parts.push({ type: "text", text: s });
		}
	};

	for (const m of mentions) {
		// Literal text between the previous cursor and this mention's
		// start (or between two adjacent mentions).
		if (m.start > cursor) {
			const gap = text.slice(cursor, m.start);
			llm.push(gap);
			appendText(gap);
		}

		const literal = text.slice(m.start, m.end); // "@<path>"
		const content = readFile(m.path);
		if (content === null) {
			// Failed read — literal substring in both outputs. The chip
			// never appears, preserving the invariant: chip ⇔ file actually
			// sent to the LLM.
			llm.push(literal);
			appendText(literal);
			failed.push(m.path);
		} else {
			// Reader `/article` format — same shape so the LLM sees one
			// convention for "file inlined into a user prompt".
			llm.push(`Path: ${m.path}\n\nContent:\n\n${content}`);
			parts.push({
				type: "file",
				mime: mimeFor(m.path),
				filename: m.path,
			});
		}
		cursor = m.end;
	}

	// Trailing text after the last mention.
	if (cursor < text.length) {
		const tail = text.slice(cursor);
		llm.push(tail);
		appendText(tail);
	}

	return {
		llmText: llm.join(""),
		displayParts: parts,
		failed,
	};
}

/** Minimal extension → mime map. Matches MIME_BADGE in `user-part.tsx`. */
function mimeFor(path: string): string {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return "text/plain";
	const ext = path.slice(dot).toLowerCase();
	if (ext === ".md" || ext === ".markdown") return "text/markdown";
	return "text/plain";
}

/**
 * Expand `@`-mention spans in a text string to their resolved absolute
 * vault paths, without reading file contents.
 *
 * Used by the slash-dispatch path in `prompt.tsx:handleSubmit` so a
 * command like `/article @foo.md` sees `args = "<abs>/foo.md"` instead
 * of the literal `@foo.md` that would fail downstream path resolution.
 * Distinct from `buildMentionPayload` (which inlines file content) —
 * slash args want a bare path, not a `Path: + Content:` block.
 *
 * Mentions whose vault-relative path resolves OUTSIDE `VAULT_DIR` keep
 * their literal `@<path>` substring in place — defense-in-depth against
 * corrupted extmark metadata. The downstream command will then fail to
 * resolve it with its own error, rather than a misleading "not in X
 * folder" message for a vault-escape.
 *
 * Pure: no I/O, no renderable access. Mentions must be sorted by
 * `start` ascending (same contract as `buildMentionPayload`).
 */
export function expandMentionsToPaths(
	text: string,
	mentions: Mention[],
): string {
	if (mentions.length === 0) return text;
	const out: string[] = [];
	let cursor = 0;
	for (const m of mentions) {
		if (m.start > cursor) out.push(text.slice(cursor, m.start));
		const abs = resolve(VAULT_DIR, m.path);
		if (isInsideDir(abs, VAULT_DIR) && abs !== VAULT_DIR) {
			out.push(abs);
		} else {
			// Vault-escape or bare-vault-dir: preserve the literal `@<path>`
			// so the downstream command fails on its own terms.
			out.push(text.slice(m.start, m.end));
		}
		cursor = m.end;
	}
	if (cursor < text.length) out.push(text.slice(cursor));
	return out.join("");
}

/**
 * Read a vault-relative file safely for inline mention expansion.
 *
 * Returns the UTF-8 contents on success; `null` on any failure
 * (outside vault, symlink, non-regular file, I/O error, disallowed
 * extension). Callers surface aggregate failures via a single toast.
 *
 * Mirrors the guard pattern in `user-part.tsx` for file-chip clicks
 * and reader's `/article` loader — path must be inside `VAULT_DIR`,
 * must not be a symlink, must be a regular file. Additionally, the
 * file must have an extension in `ALLOWED_VAULT_EXTENSIONS` so a
 * manually-typed `@foo.json` doesn't bypass the dropdown's filter.
 */
export function readFileSafe(vaultRelPath: string): string | null {
	try {
		const abs = resolve(VAULT_DIR, vaultRelPath);
		if (!isInsideDir(abs, VAULT_DIR) || abs === VAULT_DIR) return null;
		const dot = vaultRelPath.lastIndexOf(".");
		if (dot === -1) return null;
		const ext = vaultRelPath.slice(dot).toLowerCase();
		if (!ALLOWED_VAULT_EXTENSIONS.has(ext)) return null;
		const stat = lstatSync(abs);
		if (stat.isSymbolicLink() || !stat.isFile()) return null;
		return readFileSync(abs, "utf-8");
	} catch {
		return null;
	}
}
