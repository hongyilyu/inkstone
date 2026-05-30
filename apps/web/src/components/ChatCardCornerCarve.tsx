/**
 * Carve-out overlay for the top-right corner of the chat card.
 *
 * Paints a sidebar-bg "tab" at the chat-card's top-right whose two bottom
 * corners taper outward into the chat-bg surface via concave arcs. The
 * TopRightControls icon cluster sits inside this tab, in chrome bg,
 * detached from the chat surface.
 *
 * Geometry sized to host the cluster (3 icon buttons, ~102×30 sitting
 * at top-3 right-3 inside the wrapper).
 */
const WIDTH = 152;
const HEIGHT = 56;
const RADIUS = 14;

export function ChatCardCornerCarve() {
	// Trace the chrome region clockwise: top edge → right edge → bottom-right
	// concave bite → bottom edge → bottom-left concave bite → left edge → close.
	// Each concave arc bulges INTO the rect so chat-bg appears to eat the corner.
	const d = [
		`M 0 0`,
		`H ${WIDTH}`,
		`V ${HEIGHT - RADIUS}`,
		// bottom-right: arc bulges UP-LEFT (into rect interior) — sweep=0
		`A ${RADIUS} ${RADIUS} 0 0 0 ${WIDTH - RADIUS} ${HEIGHT}`,
		`H ${RADIUS}`,
		// bottom-left: arc bulges UP-RIGHT (into rect interior) — sweep=0
		`A ${RADIUS} ${RADIUS} 0 0 0 0 ${HEIGHT - RADIUS}`,
		`Z`,
	].join(" ");

	return (
		<svg
			aria-hidden
			className="pointer-events-none absolute top-0 right-0"
			width={WIDTH}
			height={HEIGHT}
			viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
		>
			<path d={d} fill="var(--sidebar)" />
		</svg>
	);
}
