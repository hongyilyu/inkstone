import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { noteNonSettingsLocation } from "@/store/settings-origin";

/**
 * Root route (ADR-0024 file-based routing). Renders the active route's
 * `<Outlet/>` plus the global command palette (⌘K), which lives here so it's
 * reachable from every surface. App-wide providers (QueryClient, Runtime) stay
 * in `main.tsx` above `RouterProvider`, so route components read them via
 * context.
 */
function RootLayout() {
	// Track the last non-settings location so Esc inside the settings takeover
	// returns there rather than to a previously-viewed tab (see
	// `store/settings-origin`).
	const href = useRouterState({ select: (s) => s.location.href });
	useEffect(() => {
		noteNonSettingsLocation(href);
	}, [href]);

	return (
		<>
			<Outlet />
			<CommandPalette />
		</>
	);
}

export const Route = createRootRoute({
	component: RootLayout,
});
