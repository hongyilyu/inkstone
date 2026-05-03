import {
	parseColor,
	RGBA,
	SyntaxStyle,
	type ThemeTokenStyle,
} from "@opentui/core";
import type { ThemeColors } from "./types";

/**
 * Build the syntax-style rule set for the markdown renderer + fenced code blocks.
 * Reads only fields that already exist on ThemeColors — no new theme fields required.
 */
function getSyntaxRules(colors: ThemeColors): ThemeTokenStyle[] {
	return [
		{ scope: ["default"], style: { foreground: colors.text } },

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
		{
			scope: ["markup.heading"],
			style: { foreground: colors.primary, bold: true },
		},
		{
			scope: ["markup.heading.1"],
			style: { foreground: colors.primary, bold: true },
		},
		{
			scope: ["markup.heading.2"],
			style: { foreground: colors.primary, bold: true },
		},
		{
			scope: ["markup.heading.3"],
			style: { foreground: colors.primary, bold: true },
		},
		{
			scope: ["markup.heading.4"],
			style: { foreground: colors.primary, bold: true },
		},
		{
			scope: ["markup.heading.5"],
			style: { foreground: colors.primary, bold: true },
		},
		{
			scope: ["markup.heading.6"],
			style: { foreground: colors.primary, bold: true },
		},
		{
			scope: ["markup.bold", "markup.strong"],
			style: { foreground: colors.text, bold: true },
		},
		{
			scope: ["markup.italic"],
			style: { foreground: colors.warning, italic: true },
		},
		{
			scope: ["markup.strikethrough"],
			style: { foreground: colors.textMuted },
		},
		{
			scope: ["markup.underline"],
			style: { foreground: colors.text, underline: true },
		},
		{ scope: ["markup.list"], style: { foreground: colors.secondary } },
		{ scope: ["markup.list.checked"], style: { foreground: colors.success } },
		{
			scope: ["markup.list.unchecked"],
			style: { foreground: colors.textMuted },
		},
		{
			scope: ["markup.quote"],
			style: { foreground: colors.warning, italic: true },
		},
		{
			scope: ["markup.raw", "markup.raw.block"],
			style: { foreground: colors.success },
		},
		{
			scope: ["markup.raw.inline"],
			style: {
				foreground: colors.success,
				background: colors.backgroundElement,
			},
		},
		{
			scope: ["markup.link"],
			style: { foreground: colors.info, underline: true },
		},
		{
			scope: ["markup.link.label"],
			style: { foreground: colors.accent, underline: true },
		},
		{
			scope: ["markup.link.url"],
			style: { foreground: colors.info, underline: true },
		},
		{ scope: ["conceal"], style: { foreground: colors.textMuted } },

		// Core code scopes (for fenced code blocks)
		{
			scope: ["comment"],
			style: { foreground: colors.textMuted, italic: true },
		},
		{
			scope: ["comment.documentation"],
			style: { foreground: colors.textMuted, italic: true },
		},
		{ scope: ["keyword"], style: { foreground: colors.accent, italic: true } },
		{
			scope: ["keyword.return", "keyword.conditional", "keyword.repeat"],
			style: { foreground: colors.accent, italic: true },
		},
		{ scope: ["keyword.function"], style: { foreground: colors.secondary } },
		{
			scope: ["keyword.import", "keyword.export"],
			style: { foreground: colors.accent },
		},
		{
			scope: ["keyword.type"],
			style: { foreground: colors.info, bold: true, italic: true },
		},
		{
			scope: ["keyword.modifier", "keyword.exception"],
			style: { foreground: colors.accent, italic: true },
		},
		{
			scope: ["string", "symbol", "character"],
			style: { foreground: colors.success },
		},
		{
			scope: ["string.escape", "string.regexp"],
			style: { foreground: colors.accent },
		},
		{
			scope: ["number", "boolean", "float", "constant"],
			style: { foreground: colors.warning },
		},
		{
			scope: ["type", "module", "class", "namespace"],
			style: { foreground: colors.info },
		},
		{
			scope: [
				"function",
				"function.call",
				"function.method",
				"function.method.call",
				"constructor",
			],
			style: { foreground: colors.secondary },
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
			style: { foreground: colors.text },
		},
		{
			scope: [
				"operator",
				"keyword.operator",
				"punctuation",
				"punctuation.bracket",
				"punctuation.delimiter",
			],
			style: { foreground: colors.text },
		},
		{
			scope: ["attribute", "annotation"],
			style: { foreground: colors.warning },
		},
		{ scope: ["tag"], style: { foreground: colors.error } },
		{ scope: ["tag.attribute"], style: { foreground: colors.accent } },
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
