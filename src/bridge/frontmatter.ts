/**
 * Article frontmatter parser.
 *
 * Lives in `bridge/` because both the backend (reader's recommendation
 * scorer, which reads `title` / `published` / `description` /
 * `reading_completed` from disk) and the TUI (the reader's secondary-page
 * metadata strip, which reads `title` / `author` / `published` / `url`)
 * need the same shape agreement. Pure string-in / object-out; no fs, no
 * Solid, no runtime dependencies.
 *
 * Scope: the handwritten "YAML-lite" subset actually used by the Obsidian
 * Clipper exports in the corpus (74 captured articles surveyed). Handles
 * `key: value` lines between the first pair of `---` delimiters, optional
 * surrounding single/double quotes on scalars, and simple block sequences
 * of quoted strings (used for `author:` when the article was co-written).
 * Does NOT handle nested maps, flow sequences, multi-line scalars
 * (`|` / `>`), anchors, or comments — deliberately shallow, the corpus
 * has no instances of those shapes.
 *
 * Unknown keys survive on the returned record so additional fields (e.g.
 * `reading_intent`, `note`) can be read by specific callers without
 * adding them here.
 */

/**
 * Frontmatter values this parser recognizes. String for scalars, string
 * array for block sequences of quoted strings. Unknown keys fall through
 * as `string` (the raw RHS after quote-stripping).
 */
export type FrontmatterValue = string | string[];

export interface ParsedFrontmatter {
	/** Parsed key/value pairs. Empty object when the block was absent or malformed. */
	fields: Record<string, FrontmatterValue>;
	/** Content with the frontmatter block removed, preserving body whitespace. */
	body: string;
}

/**
 * Strip surrounding single- or double-quotes from a scalar, matching the
 * Clipper export convention. Leaves unquoted values alone.
 */
function stripQuotes(value: string): string {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}

/** Detect a block-sequence item line: 2+ leading spaces then `- `. */
const BLOCK_ITEM_RE = /^\s+-\s+(.*)$/;

/**
 * Parse the YAML frontmatter block at the start of `input`.
 *
 * Returns `{ fields: {}, body: input }` when the input does not begin
 * with a `---` fence (most markdown surfaces that aren't captured
 * articles), so callers can blindly call this on any markdown content.
 */
export function parseFrontmatter(input: string): ParsedFrontmatter {
	const lines = input.split("\n");
	// First line must be a `---` fence. We trim the candidate to tolerate
	// trailing whitespace and `\r` (Windows line endings surface on
	// Obsidian Clipper exports captured on Windows hosts) without widening
	// the grammar elsewhere — a leading blank line is still not accepted,
	// the fence must be at byte 0.
	if (lines.length === 0 || lines[0]?.trim() !== "---") {
		return { fields: {}, body: input };
	}

	const fields: Record<string, FrontmatterValue> = {};

	// Walk until we hit the closing `---` fence or run out of lines.
	// When no closing fence exists, fall back to treating the whole input
	// as body — a half-open fence is a corrupt export, not a signal to
	// eat the rest of the document as frontmatter.
	let closeIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			closeIdx = i;
			break;
		}
	}
	if (closeIdx === -1) {
		return { fields: {}, body: input };
	}

	// Parse the block. Track the last top-level key so a block-sequence
	// under it (indented `- item` lines) collects into an array value.
	let lastKey: string | null = null;
	for (let i = 1; i < closeIdx; i++) {
		const line = lines[i] ?? "";
		if (line.length === 0) {
			lastKey = null;
			continue;
		}

		// Block-sequence item under the last seen key.
		const itemMatch = line.match(BLOCK_ITEM_RE);
		if (itemMatch && lastKey) {
			const existing = fields[lastKey];
			const value = stripQuotes(itemMatch[1]?.trim() ?? "");
			if (!value) continue;
			if (Array.isArray(existing)) {
				existing.push(value);
			} else {
				// The seed case: a top-level `key:` line with an empty
				// RHS stored an empty-string placeholder; this branch
				// promotes it to a single-item array on first child
				// item, then subsequent items land in the array-branch
				// above. A non-empty prior scalar followed by an
				// indented item is malformed YAML and not in the
				// corpus — treated the same as the empty-scalar case
				// (promote to array, drop the scalar) rather than
				// silently concatenating two shapes that were never
				// meant to coexist.
				fields[lastKey] = [value];
			}
			continue;
		}

		// Top-level `key: value` line. Any other shape (comments, nested
		// maps) is silently ignored — conservative parse, not a validator.
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		if (!key) continue;
		const rhs = line.slice(colonIdx + 1).trim();
		lastKey = key;
		if (rhs.length === 0) {
			// Empty RHS anticipates a block-sequence on the following
			// lines. Seed with empty string; the item-line branch will
			// promote to array on first item.
			fields[key] = "";
			continue;
		}
		fields[key] = stripQuotes(rhs);
	}

	// Body starts after the closing fence. Preserve the body exactly as
	// written — callers that want to trim a leading blank line can do so.
	const body = lines.slice(closeIdx + 1).join("\n");
	return { fields, body };
}

/** Narrow a frontmatter value to a scalar string, or `undefined`. */
export function fmString(
	value: FrontmatterValue | undefined,
): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Narrow a frontmatter value to `string[]`. Scalars promote to a
 * single-item array; missing values return `[]`.
 */
export function fmStringArray(value: FrontmatterValue | undefined): string[] {
	if (Array.isArray(value)) return value.filter((v) => v.length > 0);
	if (typeof value === "string" && value.length > 0) return [value];
	return [];
}
