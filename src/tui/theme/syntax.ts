import {
	parseColor,
	RGBA,
	SyntaxStyle,
	type ThemeTokenStyle,
} from "@opentui/core";
import type { ThemeColors } from "./types";

/**
 * Build the syntax-style rule set for the markdown renderer + fenced
 * code blocks. Consumes the markdown* + syntax* tokens on
 * `ThemeColors` (port of OpenCode's `getStyle` rule set at
 * `opencode/.../context/theme.tsx` lines 900-1210). Aligned to
 * OpenCode's scope-to-token mapping byte-for-byte except for the
 * H1-H6 graduated palette below, which is Inkstone-specific.
 *
 * Exported for tests — rule introspection is the cheapest way to
 * verify scope-to-token wiring without rendering.
 */
export function getSyntaxRules(colors: ThemeColors): ThemeTokenStyle[] {
	return [
		{ scope: ["default"], style: { foreground: colors.markdownText } },

		// Prompt extmark scopes. Lives in the shared rule set so the style id
		// resolves against whichever `SyntaxStyle` instance is live — on
		// theme switches `generateSyntax` recreates the instance with this
		// rule re-registered, and `syntax().getStyleId("extmark.file")`
		// returns the new id. See `src/tui/components/prompt.tsx` for the
		// extmark create-site.
		{
			scope: ["extmark.file"],
			style: { foreground: colors.warning, bold: true },
		},

		// Markdown structure
		//
		// Heading hierarchy uses a graduated palette so document structure
		// is visible at a glance in the reader. Corpus-justified: H2 is the
		// dominant body heading (~594 occurrences across 74 captured
		// articles) and H1 is typically reserved for the document title
		// (~102 occurrences); H3 shows up as a subsection (~91); H4 is
		// rare (~6); H5/H6 are unused. Each level gets a distinct hue from
		// the active theme's existing named colors.
		//
		// Inkstone-specific divergence from OpenCode: OpenCode collapses
		// every heading level onto a single `markdownHeading` token.
		// Inkstone retains the graduated palette because the corpus
		// analysis above predates the token port and the visual
		// distinction is load-bearing for reader scannability. The
		// `markdownHeading` token is still declared on `ThemeColors` (for
		// any future consumer) and backs the fallback `markup.heading`
		// rule; H1-H6 override explicitly below.
		{
			scope: ["markup.heading"],
			style: { foreground: colors.markdownHeading, bold: true },
		},
		{
			scope: ["markup.heading.1"],
			style: { foreground: colors.primary, bold: true },
		},
		{
			scope: ["markup.heading.2"],
			style: { foreground: colors.accent, bold: true },
		},
		{
			scope: ["markup.heading.3"],
			style: { foreground: colors.secondary, bold: true },
		},
		{
			scope: ["markup.heading.4"],
			style: { foreground: colors.text, bold: true },
		},
		// H5/H6 are unused in the captured-article corpus. H5 keeps the
		// H4 weight so occasional long-tail usage still looks like a
		// heading; H6 deprioritizes to `textMuted` so a deeply-nested
		// heading doesn't compete with body text for attention.
		{
			scope: ["markup.heading.5"],
			style: { foreground: colors.text, bold: true },
		},
		{
			scope: ["markup.heading.6"],
			style: { foreground: colors.textMuted, bold: true },
		},
		{
			scope: ["markup.bold", "markup.strong"],
			style: { foreground: colors.markdownStrong, bold: true },
		},
		{
			scope: ["markup.italic"],
			style: { foreground: colors.markdownEmph, italic: true },
		},
		{
			scope: ["markup.strikethrough"],
			style: { foreground: colors.textMuted },
		},
		{
			scope: ["markup.underline"],
			style: { foreground: colors.markdownText, underline: true },
		},
		{ scope: ["markup.list"], style: { foreground: colors.markdownListItem } },
		{ scope: ["markup.list.checked"], style: { foreground: colors.success } },
		{
			scope: ["markup.list.unchecked"],
			style: { foreground: colors.textMuted },
		},
		{
			scope: ["markup.quote"],
			style: { foreground: colors.markdownBlockQuote, italic: true },
		},
		{
			scope: ["markup.raw", "markup.raw.block"],
			style: { foreground: colors.markdownCode },
		},
		{
			scope: ["markup.raw.inline"],
			style: {
				foreground: colors.markdownCode,
				background: colors.backgroundElement,
			},
		},
		{
			scope: ["markup.link"],
			style: { foreground: colors.markdownLink, underline: true },
		},
		{
			scope: ["markup.link.label"],
			style: { foreground: colors.markdownLinkText, underline: true },
		},
		{
			scope: ["markup.link.url"],
			style: { foreground: colors.markdownLink, underline: true },
		},
		{ scope: ["conceal"], style: { foreground: colors.textMuted } },

		// Core code scopes (fenced code blocks). Foregrounds come from
		// the syntax* token family — italic / bold modifiers are
		// Inkstone-specific emphasis choices kept from pre-port.
		{
			scope: ["comment"],
			style: { foreground: colors.syntaxComment, italic: true },
		},
		{
			scope: ["comment.documentation"],
			style: { foreground: colors.syntaxComment, italic: true },
		},
		{
			scope: ["keyword"],
			style: { foreground: colors.syntaxKeyword, italic: true },
		},
		{
			scope: ["keyword.return", "keyword.conditional", "keyword.repeat"],
			style: { foreground: colors.syntaxKeyword, italic: true },
		},
		{
			scope: ["keyword.function"],
			style: { foreground: colors.syntaxFunction },
		},
		{
			scope: ["keyword.import", "keyword.export"],
			style: { foreground: colors.syntaxKeyword },
		},
		{
			scope: ["keyword.type"],
			style: { foreground: colors.syntaxType, bold: true, italic: true },
		},
		{
			scope: ["keyword.modifier", "keyword.exception"],
			style: { foreground: colors.syntaxKeyword, italic: true },
		},
		{
			scope: ["string", "symbol", "character"],
			style: { foreground: colors.syntaxString },
		},
		{
			scope: ["string.escape", "string.regexp"],
			style: { foreground: colors.syntaxKeyword },
		},
		{
			scope: ["number", "boolean", "float", "constant"],
			style: { foreground: colors.syntaxNumber },
		},
		{
			scope: ["type", "module", "class", "namespace"],
			style: { foreground: colors.syntaxType },
		},
		{
			scope: [
				"function",
				"function.call",
				"function.method",
				"function.method.call",
				"constructor",
			],
			style: { foreground: colors.syntaxFunction },
		},
		{
			scope: [
				"variable",
				"variable.parameter",
				"variable.member",
				"property",
				"parameter",
				"field",
			],
			style: { foreground: colors.syntaxVariable },
		},
		{
			scope: [
				"operator",
				"keyword.operator",
				"punctuation",
				"punctuation.bracket",
				"punctuation.delimiter",
			],
			style: { foreground: colors.syntaxOperator },
		},
		{
			scope: ["attribute", "annotation"],
			style: { foreground: colors.warning },
		},
		{ scope: ["tag"], style: { foreground: colors.error } },
		{ scope: ["tag.attribute"], style: { foreground: colors.syntaxKeyword } },
		{
			scope: [
				"variable.builtin",
				"type.builtin",
				"function.builtin",
				"constant.builtin",
			],
			style: { foreground: colors.error },
		},
	];
}

/**
 * Build the `SyntaxStyle` used by the markdown renderer + fenced code
 * blocks. The caller owns the returned instance — `SyntaxStyle` wraps
 * an FFI pointer (see `@opentui/core/zig.d.ts: destroySyntaxStyle`)
 * and must be explicitly `.destroy()`-ed when replaced or on provider
 * disposal. See `ThemeProvider`'s `createMemo` for the lifecycle.
 */
export function generateSyntax(colors: ThemeColors): SyntaxStyle {
	return SyntaxStyle.fromTheme(getSyntaxRules(colors));
}

/**
 * `generateSyntax` variant where every rule's `foreground` has its alpha
 * replaced by `colors.thinkingOpacity`. Used for rendering reasoning blocks:
 * hue-per-scope is preserved, but everything reads uniformly faded.
 * Mirrors OpenCode's `generateSubtleSyntax` (see opencode's `context/theme.tsx`).
 * `RGBA.fromValues` takes 0–1 floats (see `@opentui/core/lib/RGBA.d.ts`),
 * so no rescale is needed when copying r/g/b off the source RGBA.
 */
export function generateSubtleSyntax(colors: ThemeColors): SyntaxStyle {
	const rules = getSyntaxRules(colors);
	return SyntaxStyle.fromTheme(
		rules.map((rule) => {
			if (!rule.style.foreground) return rule;
			// `foreground` is typed as `ColorInput` (RGBA | string); all rules in
			// `getSyntaxRules` pass pre-resolved RGBAs, but the union forces us
			// to normalize via `parseColor` to safely read r/g/b.
			const fg = parseColor(rule.style.foreground);
			return {
				...rule,
				style: {
					...rule.style,
					foreground: RGBA.fromValues(fg.r, fg.g, fg.b, colors.thinkingOpacity),
				},
			};
		}),
	);
}
