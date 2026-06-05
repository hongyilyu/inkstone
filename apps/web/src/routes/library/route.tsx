import { createFileRoute, Outlet } from "@tanstack/react-router";
import { LibraryNav } from "@/components/library/LibraryNav";

/**
 * Library shell (peer to Chat, reached from the sidebar). A takeover surface
 * like Settings: its own left nav plus the content `<Outlet/>`. A soft
 * primary-tinted glow warms the top of every Library page (leaning into the
 * identity without flooding the reading surface).
 */
function LibraryLayout() {
	return (
		<div className="flex h-full bg-sidebar text-sidebar-foreground">
			<LibraryNav />
			<div className="relative min-w-0 flex-1 overflow-hidden bg-chat-bg">
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 top-0 h-72"
					style={{
						backgroundImage:
							"radial-gradient(120% 80% at 50% -20%, color-mix(in oklch, var(--primary) 12%, transparent), transparent 62%)",
					}}
				/>
				<div className="relative h-full">
					<Outlet />
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute("/library")({
	component: LibraryLayout,
});
