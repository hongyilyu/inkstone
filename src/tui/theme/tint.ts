/**
 * Color-math helpers + ANSI constants ported from OpenCode's theme
 * generator (see `opencode/packages/opencode/src/cli/cmd/tui/context/theme.tsx`,
 * around the `tint` function at line 509 and the `ansiColors` block at
 * line 533). Inkstone doesn't load terminal palettes, so we ship a
 * fixed `ansiColors` table matching OpenCode's `col(i)` fallback
 * (`ansiToRgba`) for the same indices. `red` / `green` /
 * `redBright` / `greenBright` drive the diff derivation;
 * `yellow` / `blue` / `magenta` / `cyan` drive the markdown +
 * syntax derivations.
 *
 * The derivation logic mirrors OpenCode byte-for-byte so that when
 * OpenCode's named theme roster is eventually ported (tracked in
 * `docs/TODO.md`), those themes render identically to their OpenCode
 * source.
 */

import { RGBA } from "@opentui/core";

/**
 * OpenCode's exact tint formula: linear blend in sRGB between `base`
 * and `overlay` by `alpha`. Not gamma-correct — deliberate, matches
 * OpenCode's output.
 *
 * `RGBA.r/g/b` are 0-1 floats on OpenTUI's RGBA; the rounding at the
 * end matches OpenCode's `Math.round(r * 255)` step before feeding
 * `RGBA.fromInts`. Given the same `base` and `overlay`, this
 * function produces the same output OpenCode would for those inputs.
 */
export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
	const r = base.r + (overlay.r - base.r) * alpha;
	const g = base.g + (overlay.g - base.g) * alpha;
	const b = base.b + (overlay.b - base.b) * alpha;
	return RGBA.fromInts(
		Math.round(r * 255),
		Math.round(g * 255),
		Math.round(b * 255),
	);
}

/**
 * Fixed ANSI color references used by every theme derivation. Values
 * match OpenCode's `ansiToRgba` fallback table for indices 0-15 (see
 * `opencode/.../context/theme.tsx` lines 258-280). This is the VGA
 * palette, not xterm — the dimmer primaries here produce the same
 * tinted backgrounds OpenCode's themes render against.
 *
 * These are not per-theme. The whole point is a stable anchor so
 * `tint(background, ansiColors.green, 0.22)` produces the same hue
 * family regardless of which theme is active, matching OpenCode's
 * output for the same theme.
 *
 * Current derivations read `red` / `green` / `redBright` /
 * `greenBright` for the diff family, and `yellow` / `blue` /
 * `magenta` / `cyan` for the markdown + syntax families. All eight
 * primaries are kept in one place so future derivations don't have
 * to widen the table and touch unrelated call sites.
 */
export const ansiColors = {
	red: RGBA.fromHex("#800000"),
	green: RGBA.fromHex("#008000"),
	yellow: RGBA.fromHex("#808000"),
	blue: RGBA.fromHex("#000080"),
	magenta: RGBA.fromHex("#800080"),
	cyan: RGBA.fromHex("#008080"),
	redBright: RGBA.fromHex("#ff0000"),
	greenBright: RGBA.fromHex("#00ff00"),
} as const;

/**
 * Inputs the diff derivation reads from a theme's base palette.
 * Keeping this as a named type (rather than a whole `ThemeColors`)
 * makes the helper callable from a `themes.ts` file mid-construction,
 * before the full `ThemeColors` object exists.
 */
export interface DiffDerivationBase {
	background: RGBA;
	backgroundPanel: RGBA;
	textMuted: RGBA;
	border: RGBA;
}

/**
 * The 11 diff-family tokens every theme gets, derived from its base
 * palette + mode. Port of OpenCode's recipe at
 * `context/theme.tsx:546-595`.
 *
 * `diffContextBg` is `backgroundPanel` directly (OpenCode uses its
 * `grays[2]` which is what `backgroundPanel` maps to in Inkstone).
 * `diffContext` is `border` (OpenCode uses its `grays[7]`, which
 * maps to `border` in Inkstone) — deliberately distinct from
 * `diffLineNumber` which stays on `textMuted`.
 *
 * `diffAlpha` is OpenCode's `isDark ? 0.22 : 0.14` — the dark value
 * is large enough that a pure-green overlay reads as "added" at a
 * glance on a near-black background; the lighter value prevents the
 * tint from swamping the text on light backgrounds.
 */
export interface DiffTokens {
	diffAdded: RGBA;
	diffRemoved: RGBA;
	diffContext: RGBA;
	diffAddedBg: RGBA;
	diffRemovedBg: RGBA;
	diffContextBg: RGBA;
	diffHighlightAdded: RGBA;
	diffHighlightRemoved: RGBA;
	diffLineNumber: RGBA;
	diffAddedLineNumberBg: RGBA;
	diffRemovedLineNumberBg: RGBA;
}

export function deriveDiffTokens(
	base: DiffDerivationBase,
	mode: "dark" | "light",
): DiffTokens {
	const diffAlpha = mode === "dark" ? 0.22 : 0.14;
	const diffContextBg = base.backgroundPanel;
	return {
		diffAdded: ansiColors.green,
		diffRemoved: ansiColors.red,
		diffContext: base.border,
		diffAddedBg: tint(base.background, ansiColors.green, diffAlpha),
		diffRemovedBg: tint(base.background, ansiColors.red, diffAlpha),
		diffContextBg,
		diffHighlightAdded: ansiColors.greenBright,
		diffHighlightRemoved: ansiColors.redBright,
		diffLineNumber: base.textMuted,
		diffAddedLineNumberBg: tint(diffContextBg, ansiColors.green, diffAlpha),
		diffRemovedLineNumberBg: tint(diffContextBg, ansiColors.red, diffAlpha),
	};
}

/**
 * Inputs the markdown + syntax derivations read. Mirrors the semantic
 * palette slots OpenCode's JSON theme files (e.g.
 * `opencode/.../context/theme/opencode.json`) map each markdown/syntax
 * token onto.
 */
export interface MarkdownSyntaxDerivationBase {
	primary: RGBA;
	accent: RGBA;
	info: RGBA;
	warning: RGBA;
	success: RGBA;
	error: RGBA;
	text: RGBA;
	textMuted: RGBA;
}

/**
 * The 10 markdown-family tokens every theme gets. Mirrors the
 * markdown-token assignments in OpenCode's JSON theme files — see
 * `opencode/.../context/theme/opencode.json` (dark section) for the
 * upstream mapping, which routes every token through a semantic
 * palette slot (`darkStep9 → primary`, `darkAccent → accent`,
 * `darkGreen → success`, etc.).
 *
 * An earlier version of this function read `ansiColors.*` (VGA
 * primaries like `#000080`), which is what OpenCode's `generateSystem()`
 * path does — but that path is a fallback for when the user picks the
 * `"system"` theme and we only have a raw 16-color terminal palette
 * to work from. For curated themes, OpenCode uses the JSON mapping
 * modeled below. Reading VGA primaries against a near-black theme
 * background rendered bullets and links as effectively invisible.
 *
 * Trimmed to the scopes `src/tui/theme/syntax.ts` actually consumes
 * today (`horizontalRule`, `listEnumeration`, `image`, `imageText`
 * are OpenCode-only so far — add when an Inkstone consumer
 * materializes).
 *
 * `markdownHeading` now resolves to `accent` (matching OpenCode). The
 * H1-H6 scope rules in `syntax.ts` override with Inkstone's graduated
 * palette per the corpus analysis in that file's docstring; this
 * change only affects any bare `markup.heading` scope without a level
 * digit, which is rare.
 *
 * `markdownEmph`, `markdownBlockQuote`, and `syntaxType` fold onto
 * `warning` because Inkstone has no dedicated `yellow` slot distinct
 * from `warning`. OpenCode keeps them on a separate `darkYellow`.
 * Accepted cosmetic divergence.
 */
export interface MarkdownTokens {
	markdownText: RGBA;
	markdownHeading: RGBA;
	markdownStrong: RGBA;
	markdownEmph: RGBA;
	markdownBlockQuote: RGBA;
	markdownListItem: RGBA;
	markdownLink: RGBA;
	markdownLinkText: RGBA;
	markdownCode: RGBA;
	markdownCodeBlock: RGBA;
}

export function deriveMarkdownTokens(
	base: MarkdownSyntaxDerivationBase,
): MarkdownTokens {
	return {
		markdownText: base.text,
		markdownHeading: base.accent,
		markdownStrong: base.warning,
		markdownEmph: base.warning,
		markdownBlockQuote: base.warning,
		markdownListItem: base.primary,
		markdownLink: base.primary,
		markdownLinkText: base.info,
		markdownCode: base.success,
		markdownCodeBlock: base.text,
	};
}

/**
 * The 9 syntax-family tokens every theme gets. Mirrors the
 * syntax-token assignments in OpenCode's JSON theme files — see
 * `opencode/.../context/theme/opencode.json` (dark section) for the
 * upstream mapping. Same reasoning as `deriveMarkdownTokens` above
 * for why this reads semantic slots instead of `ansiColors`.
 *
 * Consumed by fenced-code-block scope rules in
 * `src/tui/theme/syntax.ts`.
 */
export interface SyntaxTokens {
	syntaxComment: RGBA;
	syntaxKeyword: RGBA;
	syntaxFunction: RGBA;
	syntaxVariable: RGBA;
	syntaxString: RGBA;
	syntaxNumber: RGBA;
	syntaxType: RGBA;
	syntaxOperator: RGBA;
	syntaxPunctuation: RGBA;
}

export function deriveSyntaxTokens(
	base: MarkdownSyntaxDerivationBase,
): SyntaxTokens {
	return {
		syntaxComment: base.textMuted,
		syntaxKeyword: base.accent,
		syntaxFunction: base.primary,
		syntaxVariable: base.error,
		syntaxString: base.success,
		syntaxNumber: base.warning,
		syntaxType: base.warning,
		syntaxOperator: base.info,
		syntaxPunctuation: base.text,
	};
}
