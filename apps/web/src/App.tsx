import { ActivityRail } from "./components/ActivityRail.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { TopRightControls } from "./components/TopRightControls.js";

export default function App() {
	return (
		<div className="relative grid h-full grid-cols-[260px_1fr_320px] bg-background text-foreground">
			{/* central column delegates its own bg to ChatColumn (chat-bg, lighter than page bg). */}
			<Sidebar />
			<ChatColumn />
			<ActivityRail />
			<div className="absolute top-3 right-3 z-10">
				<TopRightControls />
			</div>
		</div>
	);
}
