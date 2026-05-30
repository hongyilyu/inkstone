import { ActivityRail } from "./components/ActivityRail.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { Sidebar } from "./components/Sidebar.js";

export default function App() {
	return (
		<div className="grid h-full grid-cols-[260px_1fr_320px] bg-background text-foreground">
			<Sidebar />
			<ChatColumn />
			<ActivityRail />
		</div>
	);
}
