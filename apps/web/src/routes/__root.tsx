import { createRootRoute, Outlet } from "@tanstack/react-router";
import { CommandPalette } from "@/components/CommandPalette";

/**
 * Root route (ADR-0024 file-based routing). Renders the active route's
 * `<Outlet/>` plus the global command palette (⌘K), which lives here so it's
 * reachable from every surface. App-wide providers (QueryClient, Runtime) stay
 * in `main.tsx` above `RouterProvider`, so route components read them via
 * context.
 */
export const Route = createRootRoute({
	component: () => (
		<>
			<Outlet />
			<CommandPalette />
		</>
	),
});
