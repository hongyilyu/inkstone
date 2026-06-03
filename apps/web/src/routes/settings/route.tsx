import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

/**
 * Settings shell (ADR-0024): the t3-styled chrome around every `/settings/*`
 * page — a "Back to Chat" affordance and the section tab nav — with the active
 * section rendered in the `<Outlet/>`. Inkstone surfaces only the Models
 * section today; the pill bar keeps t3's structure so more can be added.
 */
function SettingsLayout() {
	return (
		<main
			aria-label="Settings"
			className="h-full w-full overflow-y-auto bg-sidebar text-sidebar-foreground"
		>
			<div className="mx-auto flex max-w-[60rem] flex-col px-4 pt-6 pb-24 md:px-6">
				<header className="flex items-center justify-between pb-6 md:pb-8">
					<Link
						to="/"
						className="inline-flex items-center gap-2 rounded-md px-3 py-2 font-medium text-sm transition-colors hover:bg-muted/40"
					>
						<ArrowLeft className="size-4" aria-hidden />
						Back to Chat
					</Link>
				</header>

				<nav aria-label="Settings sections" className="mb-8">
					<div className="flex h-9 w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-secondary/80 p-1 text-secondary-foreground">
						<Link
							to="/settings/models"
							className="inline-flex items-center justify-center rounded-md px-2.5 py-1 font-medium text-sm whitespace-nowrap transition-all hover:bg-sidebar-accent/40"
							activeProps={{
								className: "bg-background text-foreground shadow-sm",
							}}
						>
							Models
						</Link>
					</div>
				</nav>

				<Outlet />
			</div>
		</main>
	);
}

export const Route = createFileRoute("/settings")({
	component: SettingsLayout,
});
