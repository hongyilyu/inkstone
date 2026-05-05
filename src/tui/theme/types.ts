import type { RGBA } from "@opentui/core";

/**
 * Semantic color palette shared by every themed renderable in the TUI.
 *
 * Every field is an `RGBA` except `thinkingOpacity`, which is a 0–1 float
 * multiplier applied to syntax-style foregrounds when rendering reasoning
 * ("thinking") blocks. Mirrors OpenCode's `Theme.thinkingOpacity` (see
 * `opencode/.../context/theme.tsx`) — the reasoning body uses a
 * `subtleSyntax` variant of the normal syntax rules with foregrounds
 * rebuilt at this alpha, producing a uniformly faded rendering while
 * preserving per-scope hue. 0.6 matches OpenCode's default.
 */
export interface ThemeColors {
	primary: RGBA;
	secondary: RGBA;
	accent: RGBA;
	error: RGBA;
	warning: RGBA;
	success: RGBA;
	info: RGBA;
	text: RGBA;
	textMuted: RGBA;
	selectedListItemText: RGBA;
	background: RGBA;
	backgroundPanel: RGBA;
	backgroundElement: RGBA;
	backgroundMenu: RGBA;
	border: RGBA;
	borderActive: RGBA;
	borderSubtle: RGBA;
	thinkingOpacity: number;
	// -----------------------------------------------------------------
	// Diff family — ported from OpenCode's theme generator (see
	// `opencode/.../context/theme.tsx` around lines 546-595). Derived
	// per-theme via `deriveDiffTokens(base, mode)` from `./tint.ts`;
	// each theme's palette literal spreads the derivation after its
	// base fields. Consumed by OpenTUI's `<diff>` renderable in
	// `ToolPart`. The `diffAdded` / `diffRemoved` / `diffContext`
	// foregrounds are declared for future inline diff-stat chips
	// (no consumer today).
	// -----------------------------------------------------------------
	/** `+N` chip foreground in inline diff stats. */
	diffAdded: RGBA;
	/** `-N` chip foreground in inline diff stats. */
	diffRemoved: RGBA;
	/** Context-line foreground inside `<diff>`. */
	diffContext: RGBA;
	/** Added-line background inside `<diff>`. Tinted from `background`. */
	diffAddedBg: RGBA;
	/** Removed-line background inside `<diff>`. Tinted from `background`. */
	diffRemovedBg: RGBA;
	/** Context-line background inside `<diff>`. Defaults to `backgroundPanel`. */
	diffContextBg: RGBA;
	/** `+` sign color inside `<diff>`. */
	diffHighlightAdded: RGBA;
	/** `-` sign color inside `<diff>`. */
	diffHighlightRemoved: RGBA;
	/** Line-number foreground inside `<diff>`. */
	diffLineNumber: RGBA;
	/** Added-line number background inside `<diff>`. Tinted from `diffContextBg`. */
	diffAddedLineNumberBg: RGBA;
	/** Removed-line number background inside `<diff>`. Tinted from `diffContextBg`. */
	diffRemovedLineNumberBg: RGBA;
	// -----------------------------------------------------------------
	// Markdown family — ported from OpenCode's theme generator (see
	// `opencode/.../context/theme.tsx` lines 597-611). Derived
	// per-theme via `deriveMarkdownTokens(base)` from `./tint.ts`.
	// Consumed by `src/tui/theme/syntax.ts` scope rules; H1-H6 heading
	// hierarchy keeps Inkstone's graduated palette (see that file's
	// docstring for the corpus justification).
	// -----------------------------------------------------------------
	/** Markdown body text foreground. */
	markdownText: RGBA;
	/** Generic heading foreground. H1-H6 scopes override with graduated colors. */
	markdownHeading: RGBA;
	/** Bold / strong emphasis foreground. */
	markdownStrong: RGBA;
	/** Italic emphasis foreground. */
	markdownEmph: RGBA;
	/** Blockquote foreground. */
	markdownBlockQuote: RGBA;
	/** List-item bullet / marker foreground. */
	markdownListItem: RGBA;
	/** Link URL foreground. */
	markdownLink: RGBA;
	/** Link label (visible text) foreground. */
	markdownLinkText: RGBA;
	/** Inline + fenced code foreground. Distinct "this is code" signal. */
	markdownCode: RGBA;
	/** Fenced code block container foreground (when no syntax highlight applies). */
	markdownCodeBlock: RGBA;
	// -----------------------------------------------------------------
	// Syntax family — ported from OpenCode's theme generator (see
	// `opencode/.../context/theme.tsx` lines 613-622). Derived
	// per-theme via `deriveSyntaxTokens(base)` from `./tint.ts`.
	// Consumed by `src/tui/theme/syntax.ts` fenced-code-block scope
	// rules.
	// -----------------------------------------------------------------
	/** Comment foreground (`comment`, `comment.documentation`). */
	syntaxComment: RGBA;
	/** Keyword foreground (`keyword.*`). */
	syntaxKeyword: RGBA;
	/** Function foreground (`function.*`, `constructor`). */
	syntaxFunction: RGBA;
	/** Variable / parameter / property / field foreground. */
	syntaxVariable: RGBA;
	/** String / symbol / character foreground. */
	syntaxString: RGBA;
	/** Number / boolean / float / constant foreground. */
	syntaxNumber: RGBA;
	/** Type / module / class / namespace foreground. */
	syntaxType: RGBA;
	/** Operator foreground (`operator`, `keyword.operator`). */
	syntaxOperator: RGBA;
	/** Punctuation foreground (`punctuation.*`). */
	syntaxPunctuation: RGBA;
}

/**
 * Theme metadata + its color palette. `mode` mirrors OpenCode's
 * `generateSystem(..., mode: "dark" | "light")` pattern — it drives
 * luminance-sensitive derivations (notably `diffAlpha` in
 * `deriveDiffTokens`) that need to know which direction to tint. The
 * 4 themes Inkstone ships are all unambiguously dark or light by
 * name, so hardcoding the mode is correct; luminance inference would
 * be a deviation for no benefit.
 */
export interface ThemeDef {
	id: string;
	name: string;
	mode: "dark" | "light";
	colors: ThemeColors;
}
