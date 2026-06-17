import { ChatColumn } from "./components/ChatColumn.js";
import { RunFeed } from "./components/RunFeed.js";
import { Sidebar } from "./components/Sidebar.js";
import { WorkspaceShell } from "./components/ui/workspace-shell.js";

/** The chat surface (`/` route): presentational + router-free, with navigation injected as props (ADR-0024); layout chrome via shared `WorkspaceShell` (ADR-0021). */
export default function App({
	onOpenSettings = () => {},
	onOpenLibrary = () => {},
	onOpenThread = () => {},
}: {
	onOpenSettings?: () => void;
	onOpenLibrary?: () => void;
	onOpenThread?: (threadId: string) => void;
} = {}) {
	return (
		<WorkspaceShell
			nav={
				<Sidebar
					onOpenLibrary={onOpenLibrary}
					onOpenSettings={onOpenSettings}
				/>
			}
			rightRail={<RunFeed onOpenThread={onOpenThread} />}
			railLabel="recent runs"
		>
			<ChatColumn />
		</WorkspaceShell>
	);
}
