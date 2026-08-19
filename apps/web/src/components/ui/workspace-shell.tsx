import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { chatCardPath } from "../ChatCardRecess.js";
import { Button } from "./button.js";

export interface WorkspaceShellProps {
	/** Left rail (16rem fixed). Supplies its own landmark. */
	nav: ReactNode;
	/** Center content. Supplies its own landmark (e.g. a `<main>`). */
	children: ReactNode;
	/** Right-rail content. Omitted: plain framed card, no bay or toggle. Present: card carries the recess and a collapsible third grid track. */
	rightRail?: ReactNode;
	/** Width of the open right rail. */
	rightRailWidth?: string;
	/** Names the collapse control: "Close <railLabel>" / "Open <railLabel>". */
	railLabel?: string;
	/** Controlled collapse. Omit both to let the shell own the state; provide both to drive it. */
	collapsed?: boolean;
	onCollapsedChange?: (next: boolean) => void;
}

/** Three-region workspace frame shared by chat and Library (ADR-0021): fixed left nav, framed middle card, optional collapsible right rail. */
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

	// Direct DOM write of clip-path + border (no React state) avoids a frame of flicker — see docs/design/web-ui-components.md
	useLayoutEffect(() => {
		const el = cardRef.current;
		if (!el) return;
		const update = () => {
			const r = el.getBoundingClientRect();
			const d = chatCardPath(r.width, r.height, { bay: hasRail });
			const clip = `path("${d}")`;
			el.style.clipPath = clip;
			borderRef.current?.setAttribute("d", d);
			// Clip the border SVG to the same shape so only the inner half of the stroke shows, never cut at the viewport edge.
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
				// Keep a thin chrome strip on the right (never 0px) so the card's rounded edge and frame stay visible against the sidebar.
				gridTemplateColumns: `16rem 1fr ${
					hasRail ? (railCollapsed ? "0.5rem" : rightRailWidth) : "0.5rem"
				}`,
			}}
		>
			<div className="overflow-hidden">{nav}</div>
			<div className="relative min-h-0 pt-2">
				<div className="relative h-full">
					<div
						ref={cardRef}
						data-testid="workspace-card"
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
					{/* Frame tracing the (possibly carved) card outline — a plain CSS border can't follow the clip-path. */}
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
							<div className="flex items-center rounded-lg bg-secondary/55 p-0.5">
								<Button
									variant="icon"
									size="icon"
									className="text-foreground hover:bg-foreground/10 hover:text-foreground"
									aria-label={
										railCollapsed ? `Open ${railLabel}` : `Close ${railLabel}`
									}
									aria-pressed={railCollapsed}
									onClick={toggleRail}
								>
									{railCollapsed ? (
										<PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
									) : (
										<PanelRightClose className="h-3.5 w-3.5" aria-hidden />
									)}
								</Button>
							</div>
						</div>
					)}
				</div>
			</div>
			{hasRail && (
				<div
					data-testid="workspace-right-rail"
					className="overflow-hidden"
					// Collapsed: a visual sliver only — drop from the a11y tree and tab order.
					aria-hidden={railCollapsed || undefined}
					inert={railCollapsed || undefined}
				>
					{rightRail}
				</div>
			)}
		</div>
	);
}
