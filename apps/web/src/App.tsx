import { PanelLeftOpen, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { ActivityRail } from "./components/ActivityRail.js";
import { makeChatCardClipPath } from "./components/ChatCardRecess.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopRightControls } from "./components/TopRightControls.js";
import { Button } from "./components/ui/button.js";

export default function App() {
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [rightRailCollapsed, setRightRailCollapsed] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
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
				<Sidebar onToggleCollapse={() => setSidebarCollapsed(true)} />
			</div>
			<div className="relative min-h-0 pt-2">
				<div
					ref={chatCardRef}
					className="relative h-full"
					style={{ clipPath }}
				>
					<ChatColumn />
				</div>
				{rightRailCollapsed ? (
					<div className="absolute top-3 right-3 z-10">
						<TopRightControls
							onOpenSettings={() => setSettingsOpen(true)}
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
							onOpenSettings={() => setSettingsOpen(true)}
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
			{settingsOpen ? (
				<div className="absolute inset-0 z-20 flex items-start justify-center bg-black/30 pt-20">
					<div className="relative w-[28rem] max-w-[90vw] rounded-lg border border-border bg-background shadow-lg">
						<div className="flex items-center justify-between border-border border-b px-4 py-2">
							<span className="font-medium text-sm">Settings</span>
							<Button
								variant="icon"
								size="icon"
								aria-label="Close settings"
								onClick={() => setSettingsOpen(false)}
							>
								<X className="h-3.5 w-3.5" aria-hidden />
							</Button>
						</div>
						<SettingsPanel />
					</div>
				</div>
			) : null}
		</div>
	);
}
