import { ActivityRail } from "./components/ActivityRail.js";
import { ChatColumn } from "./components/ChatColumn.js";
import { Sidebar } from "./components/Sidebar.js";
import { WorkspaceShell } from "./components/ui/workspace-shell.js";

/**
 * The chat surface (`/` route). Presentational + router-free so it renders
 * standalone in tests; the `/` route injects `onOpenSettings` to navigate to
 * the settings route (ADR-0024). Layout chrome lives in `WorkspaceShell`, which
 * the Library surface shares (ADR-0021).
 */
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
