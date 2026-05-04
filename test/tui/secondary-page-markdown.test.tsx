/**
 * Reader-focused markdown affordances in the secondary page.
 *
 * Pins the three user-visible contracts the reader relies on when
 * opening a captured article:
 *   1. YAML frontmatter at the top of markdown content is stripped —
 *      raw `title:` / `---` glyphs must NOT leak into the rendered
 *      frame.
 *   2. Parsed frontmatter fields surface as a metadata strip above the
 *      article body (title, author, published, url).
 *   3. Body markdown features the renderer already supported (headings
 *      at multiple levels, GFM tables) survive through the new
 *      frontmatter split.
 *
 * Limitation: the char-frame harness can't observe color. The
 * per-heading color differentiation added in `src/tui/theme/syntax.ts`
 * is therefore pinned only at the "text content is present" level;
 * the actual hue each heading renders in relies on the syntax rule
 * registration being structurally correct. Acceptable per
 * AGENTS.md's test protocol for purely visual changes.
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

// Fixture styled after the corpus — Obsidian Clipper export shape with
// title / author / published / url fields in that order. Body exercises
// three heading levels, a GFM table, and a short paragraph.
const ARTICLE_FIXTURE = `---
title: "A Complete Guide To Markdown"
url: "https://example.test/guide"
author: "Matt Pocock"
published: 2026-01-18
description: "How to write markdown that renders cleanly."
reading_intent: "keeper"
---

# A Complete Guide To Markdown

## Why Markdown

Body paragraph about markdown.

### Tables

| Harness | Duration | Cost |
| --- | --- | --- |
| Solo | 20 min | $9 |
| Full | 6 hr | $200 |
`;

async function openReaderPage(content: string) {
	const fake = makeFakeSession();
	setup = await renderApp({ session: fake.factory });
	await setup.renderOnce();

	// Seed a turn so the conversation layout is active — the
	// SecondaryPage mounts inside that branch of the Layout, same as
	// the existing secondary-page tests.
	await setup.mockInput.typeText("prime");
	setup.mockInput.pressEnter();
	await setup.renderOnce();
	await Bun.sleep(20);

	openSecondaryPage({ content, title: "article" });
}

describe("secondary page — markdown affordances", () => {
	test("raw YAML frontmatter is stripped from the rendered frame", async () => {
		await openReaderPage(ARTICLE_FIXTURE);

		// Title from the frontmatter is surfaced, so that's our poll
		// target — once it appears we know the page has rendered.
		const frame = await waitForFrame(setup!, "A Complete Guide To Markdown");

		// The YAML fence `---` and the raw `title:` key must not leak
		// into the rendered output. `description:` isn't surfaced in the
		// metadata strip, so if the frontmatter isn't stripped the raw
		// value would be the most obvious tell.
		expect(frame).not.toContain("title:");
		expect(frame).not.toContain("description:");
		expect(frame).not.toContain("reading_intent:");
	});

	test("metadata strip surfaces title, author, and url", async () => {
		await openReaderPage(ARTICLE_FIXTURE);
		const frame = await waitForFrame(setup!, "A Complete Guide To Markdown");

		expect(frame).toContain("A Complete Guide To Markdown");
		expect(frame).toContain("Matt Pocock");
		// URL renders in full — users need to be able to copy it.
		expect(frame).toContain("example.test/guide");
		// Published date renders alongside author on the subline.
		expect(frame).toContain("2026-01-18");
	});

	test("body headings render across H1/H2/H3", async () => {
		await openReaderPage(ARTICLE_FIXTURE);
		const frame = await waitForFrame(setup!, "Why Markdown");

		// Body heading text survives the frontmatter split. Color
		// differentiation is structural (see syntax.ts) and not
		// observable here.
		expect(frame).toContain("A Complete Guide To Markdown");
		expect(frame).toContain("Why Markdown");
		expect(frame).toContain("Tables");
	});

	test("GFM table cell content renders", async () => {
		await openReaderPage(ARTICLE_FIXTURE);
		const frame = await waitForFrame(setup!, "Harness");

		// Both header and data cells land in the frame regardless of
		// OpenTUI's default column layout — the reader's tableOptions
		// (grid + word wrap + borders) wrap longer cells instead of
		// truncating them.
		expect(frame).toContain("Harness");
		expect(frame).toContain("Duration");
		expect(frame).toContain("Solo");
		expect(frame).toContain("20 min");
		expect(frame).toContain("Full");
		expect(frame).toContain("$200");
	});

	test("content without frontmatter renders unchanged (no spurious header)", async () => {
		// Content that doesn't start with `---` is a bare markdown
		// body. The metadata strip should not render, and the leading
		// heading should appear at the top of the frame.
		await openReaderPage("# Bare Heading\n\nBody text.");
		const frame = await waitForFrame(setup!, "Bare Heading");

		expect(frame).toContain("Bare Heading");
		expect(frame).toContain("Body text.");
		// No frontmatter → no `by ` subline, no stray URL.
		expect(frame).not.toContain("by ");
	});

	test("format: 'text' bypasses the frontmatter strip", async () => {
		// Plain-text content that happens to start with `---` (a raw
		// log dump, a diff, a config paste) must render verbatim —
		// the frontmatter heuristic is a markdown-only affordance.
		await openReaderPage(ARTICLE_FIXTURE);
		closeSecondaryPage();
		await setup!.renderOnce();
		openSecondaryPage({
			content: "---\nkey: value\n---\n\nrest",
			format: "text",
		});
		const frame = await waitForFrame(setup!, "key: value");

		expect(frame).toContain("---");
		expect(frame).toContain("key: value");
		expect(frame).toContain("rest");
	});
});
