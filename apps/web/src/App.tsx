import { useLayoutEffect, useRef, useState } from "react";
import { ActivityRail } from "./components/ActivityRail.js";
import { chatCardPath } from "./components/ChatCardRecess.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopRightControls } from "./components/TopRightControls.js";

/**
 * The chat surface (`/` route). Presentational + router-free so it renders
 * standalone in tests; the `/` route injects `onOpenSettings` to navigate to
 * the settings route (ADR-0024).
 */
export default function App({
	onOpenSettings = () => {},
	onOpenLibrary = () => {},
}: {
	onOpenSettings?: () => void;
	onOpenLibrary?: () => void;
} = {}) {
	const [rightRailCollapsed, setRightRailCollapsed] = useState(false);
	const chatCardRef = useRef<HTMLDivElement>(null);
	const borderRef = useRef<SVGPathElement>(null);

	// The chat card's top-right is carved into a "bay" that always holds the
	// floating controls — the chrome continues into it whether the rail is open
	// or collapsed. We measure the card and write the clip-path AND the matching
	// border outline straight to the DOM inside the ResizeObserver (no React
	// state). Routing it through state lagged a frame behind the width during the
	// rail collapse animation, which made the carved edge flicker; a direct
	// style/attr write lands in the same frame as the resize.
	useLayoutEffect(() => {
		const el = chatCardRef.current;
		if (!el) return;
		const update = () => {
			const r = el.getBoundingClientRect();
			const d = chatCardPath(r.width, r.height);
			const clip = `path("${d}")`;
			el.style.clipPath = clip;
			borderRef.current?.setAttribute("d", d);
			// Clip the border SVG to the SAME shape so only the INNER half of the
			// stroke shows. Otherwise the stroke straddles the card edge and its
			// outer half is cut off-screen when the card sits at the viewport edge.
			const svg = borderRef.current?.ownerSVGElement;
			if (svg) svg.style.clipPath = clip;
		};
		update();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	return (
		<div
			className="grid h-full bg-sidebar text-sidebar-foreground motion-safe:transition-[grid-template-columns] motion-safe:duration-300 motion-safe:ease-out-quint"
			style={{
				gridTemplateColumns: `16rem 1fr ${rightRailCollapsed ? "0px" : "320px"}`,
			}}
		>
			<div className="overflow-hidden">
				<Sidebar onOpenLibrary={onOpenLibrary} />
			</div>
			<div className="relative min-h-0 pt-2">
				<div className="relative h-full">
					<div ref={chatCardRef} className="absolute inset-0 overflow-hidden">
						<div
							aria-hidden
							className="pointer-events-none absolute inset-x-0 top-0 h-72"
							style={{
								backgroundImage:
									"radial-gradient(120% 80% at 50% -20%, color-mix(in oklch, var(--primary) 12%, transparent), transparent 62%)",
							}}
						/>
						<ChatColumn />
					</div>
					{/* Frame that follows the carved bay outline (a plain CSS border
					    can't trace the clip-path). The SVG is clipped to the same path
					    so only a crisp inner ~1px shows, never cut at the viewport edge. */}
					<svg
						className="pointer-events-none absolute inset-0 size-full text-foreground/40"
						aria-hidden
					>
						<title>Chat surface frame</title>
						<path
							ref={borderRef}
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						/>
					</svg>
					<div className="absolute top-1.5 right-3 z-10">
						<TopRightControls
							onOpenSettings={onOpenSettings}
							railCollapsed={rightRailCollapsed}
							onToggleRail={() => setRightRailCollapsed((prev) => !prev)}
						/>
					</div>
				</div>
			</div>
			<div className="overflow-hidden">
				<ActivityRail />
			</div>
		</div>
	);
}
