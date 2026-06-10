import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { chatCardPath } from "../ChatCardRecess.js";
import { TopRightControls } from "../TopRightControls.js";

export interface WorkspaceShellProps {
	/** Left rail (16rem fixed). Supplies its own landmark. */
	nav: ReactNode;
	/** Center content. Supplies its own landmark (e.g. a `<main>`). */
	children: ReactNode;
	/**
	 * Right-rail content. When omitted the shell renders a plain framed card —
	 * no carved bay and no collapse control, because there is nothing to
	 * collapse. When present, the card's top edge always carries the recess for
	 * the floating toggle and a collapsible third grid track holds the rail (so
	 * the card's shape is constant whether the rail is open or collapsed).
	 */
	rightRail?: ReactNode;
	/** Width of the open right rail. */
	rightRailWidth?: string;
	/** Names the collapse control: "Close <railLabel>" / "Open <railLabel>". */
	railLabel?: string;
	/**
	 * Controlled collapse. Omit both to let the shell own the state (e.g. chat's
	 * persistent rail). Provide both to drive it (e.g. the Library opens the rail
	 * on selection and collapses it when nothing is selected).
	 */
	collapsed?: boolean;
	onCollapsedChange?: (next: boolean) => void;
}

/**
 * The three-region workspace frame shared by the chat (`/`) and Library
 * (`/library`) surfaces (ADR-0021): a fixed left nav, a framed middle "card",
 * and an optional collapsible right rail. Router-free and presentational so it
 * renders standalone in tests; pages pass the slots and decide the rail's
 * content.
 */
export function WorkspaceShell({
	nav,
	children,
	rightRail = null,
	rightRailWidth = "320px",
	railLabel = "side panel",
	collapsed,
	onCollapsedChange,
}: WorkspaceShellProps) {
	const hasRail = rightRail != null;
	const [internalCollapsed, setInternalCollapsed] = useState(false);
	const railCollapsed = collapsed ?? internalCollapsed;
	const cardRef = useRef<HTMLDivElement>(null);
	const borderRef = useRef<SVGPathElement>(null);

	const toggleRail = () => {
		const next = !railCollapsed;
		if (collapsed === undefined) setInternalCollapsed(next);
		onCollapsedChange?.(next);
	};

	// The card's top-right is carved into a "bay" that holds the floating control
	// whenever a rail is present — present or collapsed, the card shape is the
	// same, so the bay never pops in or out as the rail toggles. We measure the
	// card and write the clip-path AND the matching border outline straight to
	// the DOM inside the ResizeObserver (no React state). Routing it through state
	// lagged a frame behind the width during the collapse animation, which made
	// the carved edge flicker; a direct style/attr write lands in the same frame
	// as the resize. With no rail at all (e.g. the Library's Today overview) the
	// card is a plain rounded rectangle.
	useLayoutEffect(() => {
		const el = cardRef.current;
		if (!el) return;
		const update = () => {
			const r = el.getBoundingClientRect();
			const d = chatCardPath(r.width, r.height, { bay: hasRail });
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
	}, [hasRail]);

	return (
		<div
			className="grid h-full bg-sidebar text-sidebar-foreground motion-safe:transition-[grid-template-columns] motion-safe:duration-300 motion-safe:ease-out-quint"
			style={{
				// Collapsed: keep a thin strip of chrome (not 0px) so the card's
				// rounded right edge stays visible against the sidebar — the boundary
				// reads the same as when the rail is open. The rail's own padding means
				// this sliver only ever shows bg, no content. No rail → no third track.
				gridTemplateColumns: `16rem 1fr ${
					hasRail ? (railCollapsed ? "0.5rem" : rightRailWidth) : "0px"
				}`,
			}}
		>
			<div className="overflow-hidden">{nav}</div>
			<div className="relative min-h-0 pt-2">
				<div className="relative h-full">
					<div
						ref={cardRef}
						className="absolute inset-0 overflow-hidden bg-chat-bg"
					>
						<div
							aria-hidden
							className="pointer-events-none absolute inset-x-0 top-0 h-72"
							style={{
								backgroundImage:
									"radial-gradient(120% 80% at 50% -20%, color-mix(in oklch, var(--primary) 12%, transparent), transparent 62%)",
							}}
						/>
						{children}
					</div>
					{/* Frame that follows the (possibly carved) card outline (a plain CSS
					    border can't trace the clip-path). The SVG is clipped to the same
					    path so only a crisp inner ~1px shows, never cut at the edge. */}
					<svg
						className="pointer-events-none absolute inset-0 size-full text-foreground/40"
						aria-hidden
					>
						<title>Workspace surface frame</title>
						<path
							ref={borderRef}
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
						/>
					</svg>
					{hasRail && (
						<div className="absolute top-1.5 right-3 z-10">
							<TopRightControls
								railCollapsed={railCollapsed}
								onToggleRail={toggleRail}
								label={railLabel}
							/>
						</div>
					)}
				</div>
			</div>
			{hasRail && (
				<div
					data-testid="workspace-right-rail"
					className="overflow-hidden"
					// Collapsed, the rail is a visual sliver only — drop it from the a11y
					// tree and tab order so nothing hidden stays reachable.
					aria-hidden={railCollapsed || undefined}
					inert={railCollapsed || undefined}
				>
					{rightRail}
				</div>
			)}
		</div>
	);
}
