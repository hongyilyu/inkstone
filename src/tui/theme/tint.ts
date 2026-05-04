/**
 * Color-math helpers + ANSI constants ported from OpenCode's theme
 * generator (see `opencode/packages/opencode/src/cli/cmd/tui/context/theme.tsx`,
 * around the `tint` function at line 509 and the `ansiColors` block at
 * line 533). Inkstone doesn't load terminal palettes, so we ship a
 * fixed `ansiColors` table matching OpenCode's `col(i)` fallback
 * (`ansiToRgba`) for the same indices. These four indices (`red`,
 * `green`, `redBright`, `greenBright`) drive the diff derivation;
 * additional indices are here so follow-up phases that port
 * OpenCode's markdown / syntax token families don't need to re-open
 * this file.
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
 * `greenBright` for the diff family; the remaining primaries are
 * included now because the upcoming markdown + syntax token port
 * (phase 2) reads them and widening this table in that phase would
 * be unrelated churn.
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
