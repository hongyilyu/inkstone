import { ActivityRail } from "./components/ActivityRail.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { WorkspaceShell } from "./components/ui/workspace-shell.js";

/** The chat surface (`/` route): presentational + router-free, with navigation injected as props (ADR-0024); layout chrome via shared `WorkspaceShell` (ADR-0021). */
export default function App({
	onOpenSettings = () => {},
	onOpenLibrary = () => {},
}: {
	onOpenSettings?: () => void;
	onOpenLibrary?: () => void;
} = {}) {
	return (
		<WorkspaceShell
			nav={
				<Sidebar
					onOpenLibrary={onOpenLibrary}
					onOpenSettings={onOpenSettings}
				/>
			}
			rightRail={<ActivityRail />}
			railLabel="activity rail"
		>
			<ChatColumn />
		</WorkspaceShell>
	);
}
