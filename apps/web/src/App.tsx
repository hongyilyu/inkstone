import { PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { ActivityRail } from "./components/ActivityRail.js";
import { ChatCardCornerCarve } from "./components/ChatCardCornerCarve.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopRightControls } from "./components/TopRightControls.js";
import { Button } from "./components/ui/button.js";

export default function App() {
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [rightRailCollapsed, setRightRailCollapsed] = useState(false);

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
			<div className="min-h-0 pt-2">
				<div className="relative h-full overflow-hidden rounded-tl-2xl">
					<ChatColumn />
					<ChatCardCornerCarve />
				</div>
			</div>
			<div className="overflow-hidden">
				<ActivityRail />
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
			<div className="absolute top-3 right-3 z-10">
				<TopRightControls
					onOpenSettings={() => console.log("settings")}
					railCollapsed={rightRailCollapsed}
					onToggleRail={() => setRightRailCollapsed((prev) => !prev)}
				/>
			</div>
		</div>
	);
}
