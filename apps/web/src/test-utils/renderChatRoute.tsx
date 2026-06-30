import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WsRuntime } from "@/runtime";
import { RuntimeProvider } from "@/runtime";
import { makeQueryClient } from "./renderWithQuery";

/**
 * Mount a router-aware chat component (ADR-0061) in an ad-hoc memory router with
 * the two real chat paths — `/` (no `threadId`) and `/thread/$threadId` — both
 * rendering `element`. This gives the component its `useParams`/`useNavigate`
 * context in isolation, without the `_chat` layout's Sidebar/RunFeed siblings
 * (which would fire their own reads). The router's current location is the test's
 * source of truth for "which thread is focused".
 *
 * Returns the render result plus the live router so a test can assert the URL
 * after a navigation (`router.state.location.pathname`).
 */
export async function renderChatRoute(
	element: ReactNode,
	opts: { runtime: WsRuntime; path?: string; queryClient?: QueryClient },
): Promise<
	RenderResult & {
		router: { state: { location: { pathname: string; search: unknown } } };
	}
> {
	const rootRoute = createRootRoute({ component: Outlet });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <>{element}</>,
	});
	const threadRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/thread/$threadId",
		component: () => <>{element}</>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
		history: createMemoryHistory({ initialEntries: [opts.path ?? "/"] }),
	});
	// Resolve the initial match before render so the route's component is mounted
	// synchronously — otherwise the first paint is empty and `getBy*` would race.
	await router.load();
	const client = opts.queryClient ?? makeQueryClient();
	const result = render(
		<QueryClientProvider client={client}>
			<RuntimeProvider runtime={opts.runtime}>
				{/* biome-ignore lint/suspicious/noExplicitAny: ad-hoc test router type */}
				<RouterProvider router={router as any} />
			</RuntimeProvider>
		</QueryClientProvider>,
	);
	return { ...result, router };
}
