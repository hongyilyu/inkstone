/**
 * Distinctness check for the markdown + syntax token wiring.
 *
 * `SyntaxStyle`'s FFI surface doesn't let a test introspect the
 * compiled style by scope, so we inspect the *rule set* built by
 * `getSyntaxRules(colors)` before compilation. The assertions pin
 * the scope-to-token wiring: a regression that accidentally points
 * `markup.raw` back at `success` or leaves `keyword` on `accent`
 * would flip one of these checks.
 *
 * The test deliberately does *not* render a `<markdown>` tree — the
 * rule set is the contract; the renderer is OpenTUI's concern, and
 * asserting against rendered cell output would couple this test to
 * OpenTUI's layout.
 */

import { describe, expect, test } from "bun:test";
import type { RGBA, ThemeTokenStyle } from "@opentui/core";
import { themes } from "../../src/tui/theme/palettes";
import { getSyntaxRules } from "../../src/tui/theme/syntax";
import type { ThemeColors } from "../../src/tui/theme/types";

function fgFor(rules: ThemeTokenStyle[], scope: string): RGBA | string {
	const rule = rules.find((r) => r.scope.includes(scope));
	if (!rule) throw new Error(`no rule for scope ${scope}`);
	const fg = rule.style.foreground;
	if (!fg) throw new Error(`rule for ${scope} has no foreground`);
	return fg as RGBA | string;
}

function sameRGBA(a: RGBA | string, b: RGBA | string): boolean {
	if (typeof a === "string" || typeof b === "string") return a === b;
	return a.r === b.r && a.g === b.g && a.b === b.b;
}

describe("markdown + syntax token wiring", () => {
	for (const theme of themes) {
		describe(theme.id, () => {
			const colors: ThemeColors = theme.colors;
			const rules = getSyntaxRules(colors);

			test("markup.raw.block consumes markdownCode (not success)", () => {
				expect(
					sameRGBA(fgFor(rules, "markup.raw.block"), colors.markdownCode),
				).toBe(true);
			});

			test("markup.raw.inline consumes markdownCode with backgroundElement bg", () => {
				const rule = rules.find((r) => r.scope.includes("markup.raw.inline"));
				expect(rule).toBeTruthy();
				expect(
					sameRGBA(rule!.style.foreground as RGBA, colors.markdownCode),
				).toBe(true);
				expect(
					sameRGBA(rule!.style.background as RGBA, colors.backgroundElement),
				).toBe(true);
			});

			test("keyword consumes syntaxKeyword", () => {
				expect(sameRGBA(fgFor(rules, "keyword"), colors.syntaxKeyword)).toBe(
					true,
				);
			});

			test("string consumes syntaxString", () => {
				expect(sameRGBA(fgFor(rules, "string"), colors.syntaxString)).toBe(
					true,
				);
			});

			test("comment consumes syntaxComment", () => {
				expect(sameRGBA(fgFor(rules, "comment"), colors.syntaxComment)).toBe(
					true,
				);
			});

			test("number consumes syntaxNumber", () => {
				expect(sameRGBA(fgFor(rules, "number"), colors.syntaxNumber)).toBe(
					true,
				);
			});

			test("type consumes syntaxType", () => {
				expect(sameRGBA(fgFor(rules, "type"), colors.syntaxType)).toBe(true);
			});

			test("function consumes syntaxFunction", () => {
				expect(sameRGBA(fgFor(rules, "function"), colors.syntaxFunction)).toBe(
					true,
				);
			});

			test("markup.italic consumes markdownEmph", () => {
				expect(
					sameRGBA(fgFor(rules, "markup.italic"), colors.markdownEmph),
				).toBe(true);
			});

			test("markup.quote consumes markdownBlockQuote", () => {
				expect(
					sameRGBA(fgFor(rules, "markup.quote"), colors.markdownBlockQuote),
				).toBe(true);
			});

			test("markup.list consumes markdownListItem", () => {
				expect(
					sameRGBA(fgFor(rules, "markup.list"), colors.markdownListItem),
				).toBe(true);
			});

			test("markup.link consumes markdownLink", () => {
				expect(sameRGBA(fgFor(rules, "markup.link"), colors.markdownLink)).toBe(
					true,
				);
			});

			test("markup.link.label consumes markdownLinkText", () => {
				expect(
					sameRGBA(fgFor(rules, "markup.link.label"), colors.markdownLinkText),
				).toBe(true);
			});

			test("H1-H6 retain Inkstone's graduated palette (not collapsed onto markdownHeading)", () => {
				expect(sameRGBA(fgFor(rules, "markup.heading.1"), colors.primary)).toBe(
					true,
				);
				expect(sameRGBA(fgFor(rules, "markup.heading.2"), colors.accent)).toBe(
					true,
				);
				expect(
					sameRGBA(fgFor(rules, "markup.heading.3"), colors.secondary),
				).toBe(true);
				expect(sameRGBA(fgFor(rules, "markup.heading.4"), colors.text)).toBe(
					true,
				);
				expect(sameRGBA(fgFor(rules, "markup.heading.5"), colors.text)).toBe(
					true,
				);
				expect(
					sameRGBA(fgFor(rules, "markup.heading.6"), colors.textMuted),
				).toBe(true);
				// Fallback `markup.heading` uses the token (so future OpenCode
				// alignment can flip H1-H6 by editing this file alone).
				expect(
					sameRGBA(fgFor(rules, "markup.heading"), colors.markdownHeading),
				).toBe(true);
			});

			test("keyword foreground is distinct from string foreground (fenced-code readability)", () => {
				expect(sameRGBA(fgFor(rules, "keyword"), fgFor(rules, "string"))).toBe(
					false,
				);
			});

			test("comment foreground is distinct from keyword foreground", () => {
				expect(sameRGBA(fgFor(rules, "comment"), fgFor(rules, "keyword"))).toBe(
					false,
				);
			});

			test("markup.raw foreground is distinct from default body text", () => {
				expect(
					sameRGBA(fgFor(rules, "markup.raw.block"), colors.markdownText),
				).toBe(false);
			});
		});
	}
});
