import {
	createFileRoute,
	Link,
	Outlet,
	useRouter,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { useCommandOpen } from "@/store/command";
import { settingsExitHref } from "@/store/settings-origin";

/** Settings shell (ADR-0024): chrome around every `/settings/*` page — Back-to-Chat affordance, section tab nav, and the active section in the `<Outlet/>`. */
function SettingsLayout() {
	const router = useRouter();
	const commandOpen = useCommandOpen();

	// Esc exits the takeover to its origin (`store/settings-origin`), but only while the palette is closed so a first Esc dismisses the palette.
	useEffect(() => {
		if (commandOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") router.history.push(settingsExitHref());
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [commandOpen, router]);

	return (
		<main
			aria-label="Settings"
			className="relative h-full w-full overflow-y-auto bg-sidebar text-sidebar-foreground"
		>
			{/* Decorative atmospheric backdrop, theme-aware via the primary token. */}
			<div
				aria-hidden
				className="pointer-events-none fixed inset-0 -z-10"
				style={{
					backgroundImage:
						"radial-gradient(closest-corner at 50% -10%, color-mix(in oklch, var(--primary) 14%, transparent), transparent 70%)",
				}}
			/>
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
