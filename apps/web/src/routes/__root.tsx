import { Outlet, createRootRoute } from "@tanstack/react-router";

/**
 * Root route (ADR-0024 file-based routing). Renders only the active route's
 * `<Outlet/>`; app-wide providers (QueryClient, Runtime) stay in `main.tsx`
 * above `RouterProvider`, so route components read them via context.
 */
export const Route = createRootRoute({
	component: () => <Outlet />,
});
