/**
 * Carve-out overlay for the top-right corner of the chat card.
 *
 * Paints a sidebar-bg "tab" at the chat-card's top-right whose bottom-LEFT
 * corner tapers outward into the chat-bg surface via a single concave arc.
 * The TopRightControls icon cluster sits inside this tab, in chrome bg,
 * detached from the chat surface.
 *
 * The bottom-RIGHT of the tab is flush — no concave bite — because the
 * chat wrapper paints a thin chrome strip down its right edge that merges
 * the tab seamlessly with the activity rail. The only chat-bg/chrome
 * boundary is the bottom-LEFT arc.
 *
 * Geometry sized to host the cluster (3 icon buttons, ~102×30 sitting
 * at top-3 right-3 inside the wrapper).
 */
const WIDTH = 168;
const HEIGHT = 56;
const RADIUS = 28;

export function ChatCardCornerCarve() {
	// Trace the chrome region clockwise: top edge → right edge → flush bottom-right
	// → left along bottom → bottom-left concave arc → up the left edge → close.
	// The single arc bulges INTO the rect so chat-bg appears to eat the corner.
	const d = [
		`M 0 0`,
		`H ${WIDTH}`,
		`V ${HEIGHT}`,
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
