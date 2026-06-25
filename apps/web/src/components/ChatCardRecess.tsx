const RECESS_W = 92; // recess width, right-anchored; hugs the single control button
const RECESS_DEPTH = 44; // how far the bay drops below y=0
const ARC = 46; // horizontal span of the concave taper
const TL_RADIUS = 16; // top-left corner radius (matches rounded-tl-2xl)
const TR_RADIUS = 16; // top-right corner radius where the bay floor meets the right edge

/** Returns the clip-path `path()` definition for the chat card; `bay: false` gives a plain flat-top frame. See docs/design/web-chat-ui.md. */
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
			`M 0 ${TL_RADIUS}`,
			`Q 0 0 ${TL_RADIUS} 0`,
			`H ${W - TR_RADIUS}`,
			`Q ${W} 0 ${W} ${TR_RADIUS}`,
			`V ${H}`,
			`H 0`,
			`Z`,
		].join(" ");
	}

	const recessLeft = W - RECESS_W;

	return [
		// top-left corner
		`M 0 ${TL_RADIUS}`,
		`Q 0 0 ${TL_RADIUS} 0`,

		// flat top edge up to the bay's left arc
		`H ${recessLeft}`,

		// left shoulder of bay: S-curve flush (horizontal tangent) at both ends
		`C ${recessLeft + ARC / 2} 0 ${recessLeft + ARC / 2} ${RECESS_DEPTH} ${recessLeft + ARC} ${RECESS_DEPTH}`,

		// flat floor of the bay
		`H ${W - TR_RADIUS}`,

		// top-right corner, then down the right edge
		`Q ${W} ${RECESS_DEPTH} ${W} ${RECESS_DEPTH + TR_RADIUS}`,
		`V ${H}`,
		`H 0`,
		`Z`,
	].join(" ");
}
