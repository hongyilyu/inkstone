/**
 * Block splitter for Obsidian wikilink images.
 *
 * The splitter walks the article body line-by-line and pulls each
 * line whose sole non-whitespace content is `![[<path>]]` out into
 * its own `image` segment. Surrounding markdown lands in `text`
 * segments. The secondary page mounts an image renderable for each
 * `image` segment as a sibling of the `<markdown>` for the surrounding
 * `text` segments.
 *
 * We split rather than rewrite-in-place because OpenTUI 0.1.99's
 * `MarkdownRenderable` lifecycle destroys custom `_renderNode`
 * children on the second `updateBlocks` pass; rationale captured in
 * the source file's header.
 */

import { describe, expect, test } from "bun:test";
import { splitWikilinks } from "../src/tui/util/wikilink";

describe("splitWikilinks", () => {
	test("plain markdown body → single text segment", () => {
		const md = "# Heading\n\nBody paragraph.\n";
		expect(splitWikilinks(md)).toEqual([
			{ kind: "text", content: md.trimEnd() },
		]);
	});

	test("wikilink-only line → single image segment", () => {
		expect(splitWikilinks("![[a/b.jpg]]")).toEqual([
			{ kind: "image", href: "a/b.jpg" },
		]);
	});

	test("path with spaces is preserved verbatim (no URL encoding)", () => {
		// The path goes straight to `resolveImageSource` which calls
		// `path.resolve(VAULT_DIR, ...)`; spaces are fine — the renderable
		// reads the file by absolute path, not URL.
		expect(
			splitWikilinks("![[080 ASSETS/081 Images/Foo Bar/baz.png]]"),
		).toEqual([
			{ kind: "image", href: "080 ASSETS/081 Images/Foo Bar/baz.png" },
		]);
	});

	test("optional resize hint `|400` is stripped (path preserved)", () => {
		expect(splitWikilinks("![[foo.png|400]]")).toEqual([
			{ kind: "image", href: "foo.png" },
		]);
	});

	test("text → image → text produces three segments in order", () => {
		const md = ["# Heading", "", "![[a/foo.jpg]]", "", "After image."].join(
			"\n",
		);
		expect(splitWikilinks(md)).toEqual([
			{ kind: "text", content: "# Heading" },
			{ kind: "image", href: "a/foo.jpg" },
			{ kind: "text", content: "After image." },
		]);
	});

	test("multiple images alternate with text", () => {
		const md = [
			"intro",
			"",
			"![[one.jpg]]",
			"",
			"middle",
			"",
			"![[two.png]]",
			"",
			"end",
		].join("\n");
		const segs = splitWikilinks(md);
		expect(segs).toEqual([
			{ kind: "text", content: "intro" },
			{ kind: "image", href: "one.jpg" },
			{ kind: "text", content: "middle" },
			{ kind: "image", href: "two.png" },
			{ kind: "text", content: "end" },
		]);
	});

	test("inline (mid-line) wikilink stays in the text segment", () => {
		// Embedded wikilinks render as literal `![[…]]` text by design —
		// corpus has zero such cases. If a future article needs it, we'd
		// extend the matcher to fire mid-line and split paragraphs.
		const md = "Caption: ![[foo.png]] (figure 1)";
		expect(splitWikilinks(md)).toEqual([{ kind: "text", content: md }]);
	});

	test("non-image wikilinks (`[[...]]` without leading `!`) are not touched", () => {
		const md = "see [[other-note]] for context";
		expect(splitWikilinks(md)).toEqual([{ kind: "text", content: md }]);
	});

	test("trailing blank lines around an image segment are trimmed", () => {
		// Without trimming, `text` segments would carry their trailing
		// blank lines and the visual gap between an image and the next
		// paragraph would compound to 2-3 lines instead of one.
		const md = ["intro", "", "", "![[x.png]]", "", "", "end"].join("\n");
		expect(splitWikilinks(md)).toEqual([
			{ kind: "text", content: "intro" },
			{ kind: "image", href: "x.png" },
			{ kind: "text", content: "end" },
		]);
	});
});
