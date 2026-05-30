/**
 * Carves a rectangular recess out of the chat card's top-right corner so
 * the TopRightControls icon cluster sits in chrome (sidebar bg), with a
 * single concave arc where the recess's bottom-left meets the chat-bg.
 *
 * The recess's bottom-right is flush against the chat card's right edge
 * (which abuts the activity rail — same chrome color), so no concave is
 * needed there.
 *
 * Layering (in the chat-card wrapper):
 *   ChatColumn (z=0) → recess plate (z=1) → concave pseudo (z=2) → icons (z=10)
 */
const W = 152;
const H = 44;
const R = 14;

export function ChatCardRecess() {
	return (
		<>
			<div
				aria-hidden
				className="pointer-events-none absolute top-0 right-0 bg-sidebar"
				style={{ width: W, height: H }}
			/>
			<div
				aria-hidden
				className="pointer-events-none absolute bg-chat-bg"
				style={{
					width: R,
					height: R,
					top: H,
					right: W,
					borderTopRightRadius: R,
					boxShadow: `0 -${R}px 0 0 var(--sidebar)`,
				}}
			/>
		</>
	);
}
