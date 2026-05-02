/**
 * Tests for `buildMentionPayload`.
 *
 * Pure-function tests — no renderable, no I/O (`readFile` is stubbed).
 * Covers the cases the plan called out + the insertion-vs-position
 * order contract (builder assumes `mentions` sorted by `start`).
 */

import { describe, expect, test } from "bun:test";

// `./preload.ts` is auto-loaded via `bunfig.toml`, so VAULT_DIR is set
// before this test's static imports resolve. Safe to import mentions.ts
// here even though `readFileSafe` touches VAULT_DIR at call-time.
import { buildMentionPayload, type Mention } from "../src/tui/util/mentions";

/** Stub `readFile` using a path→content map. Missing keys → null. */
function makeReader(files: Record<string, string>) {
	return (path: string): string | null =>
		Object.hasOwn(files, path) ? (files[path] ?? null) : null;
}

describe("buildMentionPayload", () => {
	test("no mentions → plain passthrough, displayParts undefined", () => {
		const { llmText, displayParts, failed } = buildMentionPayload(
			"hello world",
			[],
			() => null,
		);
		expect(llmText).toBe("hello world");
		expect(displayParts).toBeUndefined();
		expect(failed).toEqual([]);
	});

	test("single mention with successful read", () => {
		const text = "look at @foo.md please";
		const mentions: Mention[] = [
			{ start: 8, end: 15, path: "foo.md" }, // "@foo.md"
		];
		const { llmText, displayParts, failed } = buildMentionPayload(
			text,
			mentions,
			makeReader({ "foo.md": "FOO BODY" }),
		);
		expect(llmText).toBe("look at Path: foo.md\n\nContent:\n\nFOO BODY please");
		expect(displayParts).toEqual([
			{ type: "text", text: "look at " },
			{ type: "file", mime: "text/markdown", filename: "foo.md" },
			{ type: "text", text: " please" },
		]);
		expect(failed).toEqual([]);
	});

	test("single mention with failed read — literal fallback, no chip", () => {
		const text = "look at @missing.md please";
		const mentions: Mention[] = [{ start: 8, end: 19, path: "missing.md" }];
		const { llmText, displayParts, failed } = buildMentionPayload(
			text,
			mentions,
			() => null,
		);
		expect(llmText).toBe("look at @missing.md please");
		// Failed read collapses into adjacent text parts.
		expect(displayParts).toEqual([
			{ type: "text", text: "look at @missing.md please" },
		]);
		expect(failed).toEqual(["missing.md"]);
	});

	test("multiple mentions — mixed success/failure", () => {
		const text = "see @a.md and @b.md and @c.md";
		const mentions: Mention[] = [
			{ start: 4, end: 9, path: "a.md" },
			{ start: 14, end: 19, path: "b.md" },
			{ start: 24, end: 29, path: "c.md" },
		];
		const { llmText, displayParts, failed } = buildMentionPayload(
			text,
			mentions,
			makeReader({ "a.md": "A", "c.md": "C" }),
		);
		// a (success) + " and @b.md and " (gap+failed merged) + c (success)
		expect(llmText).toBe(
			"see Path: a.md\n\nContent:\n\nA and @b.md and Path: c.md\n\nContent:\n\nC",
		);
		expect(displayParts).toEqual([
			{ type: "text", text: "see " },
			{ type: "file", mime: "text/markdown", filename: "a.md" },
			// The gap between a and b PLUS the failed @b.md literal PLUS
			// the gap between b and c all collapse into a single text run.
			{ type: "text", text: " and @b.md and " },
			{ type: "file", mime: "text/markdown", filename: "c.md" },
		]);
		expect(failed).toEqual(["b.md"]);
	});

	test("mention at start of text", () => {
		const text = "@foo.md is interesting";
		const mentions: Mention[] = [{ start: 0, end: 7, path: "foo.md" }];
		const { llmText, displayParts } = buildMentionPayload(
			text,
			mentions,
			makeReader({ "foo.md": "X" }),
		);
		expect(llmText).toBe("Path: foo.md\n\nContent:\n\nX is interesting");
		expect(displayParts).toEqual([
			{ type: "file", mime: "text/markdown", filename: "foo.md" },
			{ type: "text", text: " is interesting" },
		]);
	});

	test("mention at end of text", () => {
		const text = "read @foo.md";
		const mentions: Mention[] = [{ start: 5, end: 12, path: "foo.md" }];
		const { llmText, displayParts } = buildMentionPayload(
			text,
			mentions,
			makeReader({ "foo.md": "X" }),
		);
		expect(llmText).toBe("read Path: foo.md\n\nContent:\n\nX");
		expect(displayParts).toEqual([
			{ type: "text", text: "read " },
			{ type: "file", mime: "text/markdown", filename: "foo.md" },
		]);
	});

	test("adjacent mentions (no gap) render as separate file parts", () => {
		// Adjacent is rare (insertion puts a trailing space) but handle it:
		// two successive file parts, no text between them.
		const text = "@a.md@b.md";
		const mentions: Mention[] = [
			{ start: 0, end: 5, path: "a.md" },
			{ start: 5, end: 10, path: "b.md" },
		];
		const { llmText, displayParts } = buildMentionPayload(
			text,
			mentions,
			makeReader({ "a.md": "A", "b.md": "B" }),
		);
		expect(llmText).toBe(
			"Path: a.md\n\nContent:\n\nAPath: b.md\n\nContent:\n\nB",
		);
		expect(displayParts).toEqual([
			{ type: "file", mime: "text/markdown", filename: "a.md" },
			{ type: "file", mime: "text/markdown", filename: "b.md" },
		]);
	});

	test("txt mime resolves to text/plain", () => {
		const text = "@notes.txt";
		const mentions: Mention[] = [{ start: 0, end: 10, path: "notes.txt" }];
		const { displayParts } = buildMentionPayload(
			text,
			mentions,
			makeReader({ "notes.txt": "content" }),
		);
		expect(displayParts).toEqual([
			{ type: "file", mime: "text/plain", filename: "notes.txt" },
		]);
	});

	test("all-failed → all text, no file parts, all paths in failed", () => {
		const text = "@a.md and @b.md";
		const mentions: Mention[] = [
			{ start: 0, end: 5, path: "a.md" },
			{ start: 10, end: 15, path: "b.md" },
		];
		const { llmText, displayParts, failed } = buildMentionPayload(
			text,
			mentions,
			() => null,
		);
		expect(llmText).toBe("@a.md and @b.md");
		expect(displayParts).toEqual([{ type: "text", text: "@a.md and @b.md" }]);
		expect(failed).toEqual(["a.md", "b.md"]);
	});

	test("contract: unsorted mentions produce wrong output (builder assumes sorted)", () => {
		// This documents the contract — callers MUST sort by `start`
		// before calling. `handleSubmit` in `prompt.tsx` does. If someone
		// passes unsorted mentions the output is garbage, not a crash;
		// the assertion here just pins that behavior so a future "fix"
		// doesn't accidentally add a sort inside the builder (which
		// would paper over caller bugs).
		const text = "@a.md and @b.md";
		const unsorted: Mention[] = [
			{ start: 10, end: 15, path: "b.md" }, // b first
			{ start: 0, end: 5, path: "a.md" }, // a second
		];
		const { llmText } = buildMentionPayload(
			text,
			unsorted,
			makeReader({ "a.md": "A", "b.md": "B" }),
		);
		// Not the correctly-sorted expansion. Specifically, the cursor
		// advances past `end: 15` after the first (wrong) mention, so
		// the second mention's gap math (`text.slice(cursor, 0)`) is
		// empty, and the final trailing-text concat also misbehaves.
		expect(llmText).not.toBe(
			"Path: a.md\n\nContent:\n\nA and Path: b.md\n\nContent:\n\nB",
		);
	});
});
