/**
 * Shared frontmatter parser — tests for `src/bridge/frontmatter.ts`.
 *
 * Covers the shapes found in the 74-article corpus survey:
 *   - Double-quoted scalars (universal)
 *   - Single-quoted scalars
 *   - Unquoted scalars (dates, bare identifiers)
 *   - Block-sequence authors (`author:\n  - "..."`)
 *   - Missing / malformed fences
 *   - Body preservation (blank lines, leading content)
 *
 * The parser is deliberately shallow — it's not a YAML spec
 * implementation, it's the minimal surface the corpus requires.
 */

import { describe, expect, test } from "bun:test";
import {
	fmString,
	fmStringArray,
	parseFrontmatter,
} from "../src/bridge/frontmatter";

describe("parseFrontmatter", () => {
	test("double-quoted scalars", () => {
		const { fields } = parseFrontmatter(
			'---\ntitle: "Hello"\nurl: "https://example.test"\n---\nbody',
		);
		expect(fmString(fields.title)).toBe("Hello");
		expect(fmString(fields.url)).toBe("https://example.test");
	});

	test("single-quoted scalars", () => {
		const { fields } = parseFrontmatter("---\ntitle: 'Hello World'\n---\nbody");
		expect(fmString(fields.title)).toBe("Hello World");
	});

	test("unquoted scalar (date shape)", () => {
		const { fields } = parseFrontmatter(
			"---\npublished: 2026-01-18\n---\nbody",
		);
		expect(fmString(fields.published)).toBe("2026-01-18");
	});

	test("block-sequence author collects into an array", () => {
		const { fields } = parseFrontmatter(
			'---\ntitle: "x"\nauthor:\n  - "Alice"\n  - "Bob"\n---\nbody',
		);
		expect(fmStringArray(fields.author)).toEqual(["Alice", "Bob"]);
	});

	test("scalar author remains a string; fmStringArray promotes to single-item array", () => {
		const { fields } = parseFrontmatter(
			'---\nauthor: "Matt Pocock"\n---\nbody',
		);
		expect(fmString(fields.author)).toBe("Matt Pocock");
		expect(fmStringArray(fields.author)).toEqual(["Matt Pocock"]);
	});

	test("strips frontmatter from the body", () => {
		// The closing fence and its trailing `\n` both belong to the
		// frontmatter region — the body starts at whatever came after.
		// A single blank line between the closing fence and the first
		// heading is a Clipper export convention; the parser doesn't
		// collapse it, leaving that trimming to the caller (e.g.
		// SecondaryPage's `body()` accessor drops one leading `\n`).
		const { body } = parseFrontmatter(
			'---\ntitle: "x"\n---\n\n# Heading\n\nBody paragraph.',
		);
		expect(body).toBe("\n# Heading\n\nBody paragraph.");
	});

	test("no leading fence returns empty fields + original body", () => {
		const input = "# Heading\n\nBody.";
		const parsed = parseFrontmatter(input);
		expect(parsed.fields).toEqual({});
		expect(parsed.body).toBe(input);
	});

	test("missing closing fence is treated as no frontmatter", () => {
		// A half-open fence is a corrupt export. Safer to preserve the
		// whole document than to eat it as a frontmatter block.
		const input = '---\ntitle: "x"\nbody without closing fence';
		const parsed = parseFrontmatter(input);
		expect(parsed.fields).toEqual({});
		expect(parsed.body).toBe(input);
	});

	test("unknown keys pass through as strings, including Obsidian wikilink shape", () => {
		// Wikilinks use `[[...]]` brackets that happen to be valid
		// markdown-escape fodder. The parser must leave them intact —
		// stripQuotes only removes paired outer quotes.
		const { fields } = parseFrontmatter(
			'---\nreading_intent: "keeper"\nnote: "[[Some note]]"\n---\nbody',
		);
		expect(fmString(fields.reading_intent)).toBe("keeper");
		expect(fmString(fields.note)).toBe("[[Some note]]");
		// Pin the exact stored shape so a regression that double-strips
		// brackets or quotes shows up.
		expect(fields.note).toBe("[[Some note]]");
	});

	test("trailing whitespace on a fence line is tolerated", () => {
		// Windows-exported Obsidian notes occasionally land a `\r` or
		// stray space on the fence line. The parser trims the fence
		// candidate to absorb that without widening the grammar.
		const { fields, body } = parseFrontmatter(
			'---\ntitle: "x"\n--- \nbody text',
		);
		expect(fmString(fields.title)).toBe("x");
		expect(body).toBe("body text");
	});

	test("CRLF-style closing fence is tolerated", () => {
		const { fields } = parseFrontmatter('---\r\ntitle: "x"\r\n---\r\nbody');
		// Note: split by `\n` leaves `\r` on each line; the fence match
		// must cope with that for the closing fence to land.
		expect(fmString(fields.title)).toBe("x");
	});

	test("empty input returns empty parse", () => {
		const parsed = parseFrontmatter("");
		expect(parsed.fields).toEqual({});
		expect(parsed.body).toBe("");
	});
});

describe("fmString / fmStringArray narrowing helpers", () => {
	test("fmString returns undefined for missing / empty / array values", () => {
		expect(fmString(undefined)).toBeUndefined();
		expect(fmString("")).toBeUndefined();
		expect(fmString(["a"])).toBeUndefined();
	});

	test("fmStringArray drops empty entries", () => {
		expect(fmStringArray(["a", "", "b"])).toEqual(["a", "b"]);
		expect(fmStringArray(undefined)).toEqual([]);
		expect(fmStringArray("")).toEqual([]);
	});
});
