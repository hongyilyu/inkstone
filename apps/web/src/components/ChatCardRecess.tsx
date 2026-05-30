/**
 * Builds a CSS clip-path that carves a smooth recess out of the chat
 * card's top edge for the TopRightControls icon cluster. The recess is a
 * "bay": chat-card's top edge dips down with a single smooth concave arc
 * on the left, then runs flat all the way to the right edge. The right
 * side has NO curl back up — the chat card's right edge meets the
 * activity rail (same chrome color) so the chrome continues seamlessly,
 * matching t3's reference.
 *
 * Apply via inline style on the chat-card wrapper:
 *   <div style={{ clipPath: makeChatCardClipPath(w, h) }} ... />
 */

const RECESS_W = 124; // recess width, right-anchored
const RECESS_DEPTH = 44; // how far the bay drops below y=0
const ARC = 18; // concave-arc radius (gentle taper)
const TL_RADIUS = 16; // top-left corner radius (matches rounded-tl-2xl)

/**
 * Returns the path() definition string. Trace clockwise from the top-left
 * corner's start, around the perimeter of the visible chat-card shape.
 */
export function chatCardPath(width: number, height: number): string {
	const W = width;
	const H = height;
	const recessLeft = W - RECESS_W;

	return [
		// top-left corner: curl from (0, TL_RADIUS) to (TL_RADIUS, 0)
		`M 0 ${TL_RADIUS}`,
		`Q 0 0 ${TL_RADIUS} 0`,

		// flat top edge up to where the bay's left arc begins
		`H ${recessLeft}`,

		// left shoulder of bay: concave curl DOWN-RIGHT
		// from (recessLeft, 0) to (recessLeft + ARC, RECESS_DEPTH)
		`Q ${recessLeft + ARC} 0 ${recessLeft + ARC} ${RECESS_DEPTH}`,

		// flat bottom of the bay, all the way to the right edge
		`H ${W}`,

		// down the right edge from RECESS_DEPTH to bottom
		`V ${H}`,
		// across the bottom
		`H 0`,
		// up the left edge — closes back to (0, TL_RADIUS) via Z
		`Z`,
	].join(" ");
}

export function makeChatCardClipPath(width: number, height: number): string {
	return `path("${chatCardPath(width, height)}")`;
}
