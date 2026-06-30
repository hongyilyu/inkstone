import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { RunFeed } from "@/components/RunFeed.js";
import { Sidebar } from "@/components/Sidebar.js";
import { WorkspaceShell } from "@/components/ui/workspace-shell.js";

/**
 * Pathless `_chat` layout (ADR-0061): owns the shared `WorkspaceShell` chrome —
 * the Sidebar and the recent-Runs rail — so they never remount across the
 * welcome↔Thread crossing. The center (`<ChatColumn/>` via the child route's
 * `<Outlet/>`) is the only thing that swaps. Navigation lives here at the router
 * edge: New Chat → `/`, opening a Thread → `/thread/<id>`, settings/library to
 * their routes. The Library's `_chat` twin is `routes/library/route.tsx`.
 */
function ChatLayout() {
	const navigate = useNavigate();
	return (
		<WorkspaceShell
			nav={
				<Sidebar
					onOpenLibrary={() => navigate({ to: "/library" })}
					onOpenArchived={() => navigate({ to: "/archived" })}
					onOpenSettings={() => navigate({ to: "/settings/models" })}
					onNewChat={() => navigate({ to: "/" })}
					onOpenThread={(threadId) =>
						navigate({ to: "/thread/$threadId", params: { threadId } })
					}
				/>
			}
			rightRail={
				<RunFeed
					onOpenThread={(threadId) =>
						navigate({ to: "/thread/$threadId", params: { threadId } })
					}
				/>
			}
			railLabel="recent runs"
		>
			<Outlet />
		</WorkspaceShell>
	);
}

export const Route = createFileRoute("/_chat")({
	component: ChatLayout,
});
