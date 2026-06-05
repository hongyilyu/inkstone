import { PanelLeftOpen } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { ActivityRail } from "./components/ActivityRail.js";
import { makeChatCardClipPath } from "./components/ChatCardRecess.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopRightControls } from "./components/TopRightControls.js";
import { Button } from "./components/ui/button.js";

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
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [rightRailCollapsed, setRightRailCollapsed] = useState(false);
	const chatCardRef = useRef<HTMLDivElement>(null);
	const [clipPath, setClipPath] = useState<string>("");

	useLayoutEffect(() => {
		const el = chatCardRef.current;
		if (!el) return;
		// When the rail is open, the icons sit above the rail (no carve);
		// when the rail is collapsed, the icons need a carved-out bay in the
		// chat card. Only apply the clip-path in the collapsed state.
		if (!rightRailCollapsed) {
			setClipPath("");
			return;
		}
		const update = () => {
			const r = el.getBoundingClientRect();
			setClipPath(makeChatCardClipPath(r.width, r.height));
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, [rightRailCollapsed]);

	return (
		<div
			className="relative grid h-full bg-sidebar text-sidebar-foreground"
			style={{
				gridTemplateColumns: `${sidebarCollapsed ? "0px" : "260px"} 1fr ${rightRailCollapsed ? "0px" : "320px"}`,
			}}
		>
			<div className="overflow-hidden">
				<Sidebar
					onToggleCollapse={() => setSidebarCollapsed(true)}
					onOpenLibrary={onOpenLibrary}
				/>
			</div>
			<div className="relative min-h-0 pt-2">
				<div ref={chatCardRef} className="relative h-full" style={{ clipPath }}>
					<ChatColumn />
				</div>
				{rightRailCollapsed ? (
					<div className="absolute top-3 right-3 z-10">
						<TopRightControls
							onOpenSettings={onOpenSettings}
							railCollapsed={rightRailCollapsed}
							onToggleRail={() => setRightRailCollapsed((prev) => !prev)}
						/>
					</div>
				) : null}
			</div>
			<div className="relative overflow-hidden">
				<ActivityRail />
				{rightRailCollapsed ? null : (
					<div className="absolute top-3 right-3 z-10">
						<TopRightControls
							onOpenSettings={onOpenSettings}
							railCollapsed={rightRailCollapsed}
							onToggleRail={() => setRightRailCollapsed((prev) => !prev)}
						/>
					</div>
				)}
			</div>
			{sidebarCollapsed ? (
				<Button
					variant="icon"
					size="icon"
					aria-label="Open sidebar"
					onClick={() => setSidebarCollapsed(false)}
					className="absolute top-3 left-3 z-10"
				>
					<PanelLeftOpen className="size-4" />
				</Button>
			) : null}
		</div>
	);
}
