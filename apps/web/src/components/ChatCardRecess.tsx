/**
 * Builds a CSS clip-path that carves a smooth recess out of the chat
 * card's top edge for the TopRightControls icon cluster. The recess is a
 * "bay": chat-card's top edge dips down with a single smooth concave arc
 * on the left, then runs flat to the right, where the top-right corner
 * rounds off into the right edge that meets the activity rail.
 *
 * Apply via inline style on the chat-card wrapper:
 *   <div style={{ clipPath: makeChatCardClipPath(w, h) }} ... />
 */

const RECESS_W = 92; // recess width, right-anchored; hugs the single control button
const RECESS_DEPTH = 44; // how far the bay drops below y=0
const ARC = 46; // horizontal span of the concave taper
const TL_RADIUS = 16; // top-left corner radius (matches rounded-tl-2xl)
const TR_RADIUS = 16; // top-right corner radius where the bay floor meets the right edge

/**
 * Returns the path() definition string. Trace clockwise from the top-left
 * corner's start, around the perimeter of the visible card shape. With
 * `bay: false` the top edge stays flat with both corners rounded — the plain
 * framed surface a page uses when it has no right rail (and so no floating
 * control to carve a recess for).
 */
export function chatCardPath(
	width: number,
	height: number,
	opts: { bay?: boolean } = {},
): string {
	const { bay = true } = opts;
	const W = width;
	const H = height;

	if (!bay) {
		return [
			// top-left corner
			`M 0 ${TL_RADIUS}`,
			`Q 0 0 ${TL_RADIUS} 0`,
			// flat top edge across to the top-right corner
			`H ${W - TR_RADIUS}`,
			`Q ${W} 0 ${W} ${TR_RADIUS}`,
			// down the right edge, across the bottom, up the left, close
			`V ${H}`,
			`H 0`,
			`Z`,
		].join(" ");
	}

	const recessLeft = W - RECESS_W;

	return [
		// top-left corner: curl from (0, TL_RADIUS) to (TL_RADIUS, 0)
		`M 0 ${TL_RADIUS}`,
		`Q 0 0 ${TL_RADIUS} 0`,

		// flat top edge up to where the bay's left arc begins
		`H ${recessLeft}`,

		// left shoulder of bay: smooth S-curve from (recessLeft, 0) to
		// (recessLeft + ARC, RECESS_DEPTH). Cubic Bezier with both control
		// points at the curve's horizontal midpoint so the tangent is
		// horizontal at BOTH ends: flush with flat top, flush with flat floor.
		`C ${recessLeft + ARC / 2} 0 ${recessLeft + ARC / 2} ${RECESS_DEPTH} ${recessLeft + ARC} ${RECESS_DEPTH}`,

		// flat floor of the bay, up to where the top-right corner rounds
		`H ${W - TR_RADIUS}`,

		// round the top-right corner, then run down the right edge to the bottom
		`Q ${W} ${RECESS_DEPTH} ${W} ${RECESS_DEPTH + TR_RADIUS}`,
		`V ${H}`,
		// across the bottom
		`H 0`,
		// up the left edge, closes back to (0, TL_RADIUS) via Z
		`Z`,
	].join(" ");
}

export function makeChatCardClipPath(width: number, height: number): string {
	return `path("${chatCardPath(width, height)}")`;
}
