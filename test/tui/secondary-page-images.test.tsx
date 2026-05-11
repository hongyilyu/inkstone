/**
 * Image rendering wired into the secondary page.
 *
 * Pins the user-visible contracts the wiring layer adds:
 *   1. Obsidian wikilinks (`![[<vault path>]]`) no longer render as
 *      literal text — the rewriter + `renderNode` route them to the
 *      Kitty image renderable, which emits placeholder cells (or a
 *      text-fallback line on resolve failure).
 *   2. Frontmatter strip still happens before the wikilink rewrite —
 *      raw YAML must not leak even when the body has wikilinks.
 *   3. Failure mode: a wikilink whose target is missing renders as a
 *      `[Image: ... — ...]` fallback line instead of crashing.
 *   4. `format: "text"` bypasses both the wikilink rewrite and the
 *      frontmatter strip — raw `![[...]]` text renders verbatim.
 *
 * The placeholder-cell encoding correctness is covered by the unit
 * tests in `test/kitty-image.test.ts`. Here we just assert the seam:
 * wikilinks don't survive as literal text in the rendered frame.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	closeSecondaryPage,
	openSecondaryPage,
} from "../../src/tui/context/secondary-page";
import { makeFakeSession } from "./fake-session";
import { renderApp, waitForFrame } from "./harness";

let setup: Awaited<ReturnType<typeof renderApp>> | undefined;

afterEach(() => {
	closeSecondaryPage();
	if (setup) {
		setup.renderer.destroy();
		setup = undefined;
	}
});

async function openReaderPage(content: string) {
	const fake = makeFakeSession();
	setup = await renderApp({ session: fake.factory });
	await setup.renderOnce();

	await setup.mockInput.typeText("prime");
	setup.mockInput.pressEnter();
	await setup.renderOnce();
	await Bun.sleep(20);

	openSecondaryPage({ content, title: "article" });
}

describe("secondary page — wikilink images", () => {
	test("missing wikilink target renders a fallback line (not literal `![[...]]`)", async () => {
		// The rewriter converts `![[no/such/file.png]]` to a standard
		// markdown image; `renderNode` routes the wrapping paragraph to
		// the Kitty image renderable; resolveImageSource returns a
		// `not found` error, which paints as `[Image: ... — not found]`.
		await openReaderPage(
			"# Article\n\n![[nonexistent/article-folder/missing.png]]\n\nFollowing paragraph.",
		);

		const frame = await waitForFrame(setup!, "Article");

		// Wikilink must NOT survive as literal text. If the rewriter or
		// renderNode path didn't fire, we'd see `![[nonexistent/...` in
		// the frame.
		expect(frame).not.toContain("![[");
		// Fallback line should be visible.
		expect(frame).toContain("[Image:");
		expect(frame).toContain("not found");
		// Surrounding article still renders.
		expect(frame).toContain("Article");
		expect(frame).toContain("Following paragraph.");
	});

	test("frontmatter strip still happens when body has wikilinks", async () => {
		const article = [
			"---",
			'title: "With Image"',
			'author: "Tester"',
			"---",
			"",
			"![[bogus/path/x.png]]",
			"",
			"After image.",
		].join("\n");

		await openReaderPage(article);
		const frame = await waitForFrame(setup!, "After image.");

		// Title surfaces from frontmatter (proves the strip ran).
		expect(frame).toContain("With Image");
		expect(frame).toContain("Tester");
		// Raw YAML must not leak.
		expect(frame).not.toContain("title:");
		// Wikilink must not render as literal text.
		expect(frame).not.toContain("![[");
		// Image fallback line is visible.
		expect(frame).toContain("[Image:");
		// Trailing text segment after the image still renders. Without
		// `flexShrink={0}` on segment markdowns, OpenTUI's flex column
		// would let trailing text siblings collapse to zero height when
		// the body starts with an image and an `<ArticleHeader>` is
		// also present.
		expect(frame).toContain("After image.");
	});

	test("format: 'text' bypasses both the rewriter and frontmatter strip", async () => {
		// Plain-text format renders raw — wikilinks should appear
		// verbatim, no rewrite, no fallback line.
		await openReaderPage("# Heading\n\n![[verbatim.png]]\n\nrest");
		closeSecondaryPage();
		await setup!.renderOnce();
		openSecondaryPage({
			content: "---\nkey: value\n---\n\n![[verbatim.png]]\n\nrest",
			format: "text",
		});
		const frame = await waitForFrame(setup!, "verbatim.png");

		// Raw frontmatter fence + wikilink both survive in text mode.
		expect(frame).toContain("---");
		expect(frame).toContain("key: value");
		expect(frame).toContain("![[verbatim.png]]");
		expect(frame).toContain("rest");
	});

	test("article without wikilinks renders unchanged (no regression)", async () => {
		// A pre-existing test from secondary-page-markdown.test.tsx covers
		// this in detail; we double-pin here to make sure adding the
		// renderNode hook didn't change non-image-paragraph rendering.
		await openReaderPage(
			"# Heading\n\nBody paragraph with **bold** text.\n\nSecond paragraph.",
		);
		const frame = await waitForFrame(setup!, "Heading");

		expect(frame).toContain("Heading");
		expect(frame).toContain("Body paragraph");
		expect(frame).toContain("Second paragraph");
		expect(frame).not.toContain("[Image:");
	});
});
