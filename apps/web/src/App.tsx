import { PanelLeftOpen } from "lucide-react";
import { useState } from "react";
import { ActivityRail } from "./components/ActivityRail.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopRightControls } from "./components/TopRightControls.js";
import { Button } from "./components/ui/button.js";

export default function App() {
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

	return (
		<div
			className="relative grid h-full bg-background text-foreground"
			style={{
				gridTemplateColumns: sidebarCollapsed
					? "0px 1fr 320px"
					: "260px 1fr 320px",
			}}
		>
			<div className="overflow-hidden">
				<Sidebar onToggleCollapse={() => setSidebarCollapsed(true)} />
			</div>
			<ChatColumn />
			<ActivityRail />
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
				<TopRightControls />
			</div>
		</div>
	);
}
