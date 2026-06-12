import {
	createRootRoute,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { noteNonSettingsLocation } from "@/store/settings-origin";

/** Root route (ADR-0024): renders the active `<Outlet/>` plus the global command palette (⌘K), reachable from every surface. */
function RootLayout() {
	// Track the last non-settings location so Esc in the settings takeover returns there, not to a prior tab (`store/settings-origin`).
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
