import type { EntityBacklinksResult, EntityRow } from "@inkstone/protocol";
import {
	type RunEventValue,
	stubWsClient,
	WsClient,
	type WsClientService,
} from "@inkstone/ui-sdk";
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
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { ReactElement, ReactNode } from "react";
import { RuntimeProvider, type WsRuntime } from "@/runtime";
import { makeQueryClient } from "./renderWithQuery";

// The single-entry render harness for Web Client view tests: internalizes the
// stubWsClient → Layer → ManagedRuntime → QueryClient → provider-nesting
// boilerplate every test file used to re-derive. Seed data rides in as plain
// wire rows (see ./rows.ts); anything a test drives beyond reads goes through
// `overrides`, which always wins over the seeds.

export { makeQueryClient } from "./renderWithQuery";

/** Seed + override surface shared by {@link makeCoreRuntime} and friends. */
export interface CoreRuntimeOptions {
	/** `entity/list` seed rows, keyed by entity type; unlisted types serve `[]`. */
	entities?: Readonly<Record<string, ReadonlyArray<EntityRow>>>;
	/** `entity/backlinks` seed; defaults to both sets empty. */
	backlinks?: EntityBacklinksResult;
	/** `run/subscribe` seed events; defaults to an empty (quiescent) stream. */
	runEvents?: ReadonlyArray<RunEventValue>;
	/** Explicit member stubs — spread LAST, so a caller override always wins. */
	overrides?: Partial<WsClientService>;
}

export interface RenderWithCoreOptions extends CoreRuntimeOptions {
	/** When given, mount a memory router at this location with the two chat
	 * routes (`/` and `/thread/$threadId`) both rendering `ui`. */
	path?: string;
}

/** The ad-hoc memory router shape tests assert against (same as renderChatRoute). */
export interface TestRouter {
	state: { location: { pathname: string; search: unknown } };
}

/**
 * Build a stubbed {@link WsRuntime}: `listEntities` serves the seeded rows by
 * type (empty for unlisted types), `getBacklinks` serves the seeded sets (both
 * empty by default), `subscribeRun` streams the seeded events (none by default).
 * Every other verb keeps stubWsClient's loud `Effect.die` default.
 */
export function makeCoreRuntime(opts: CoreRuntimeOptions = {}): WsRuntime {
	const stub = stubWsClient({
		listEntities: (type) =>
			Effect.succeed({ entities: opts.entities?.[type] ?? [] }),
		getBacklinks: () =>
			Effect.succeed(opts.backlinks ?? { mentioned_in: [], linked_todos: [] }),
		subscribeRun: () => Stream.fromIterable(opts.runEvents ?? []),
		...opts.overrides,
	});
	return ManagedRuntime.make(Layer.succeed(WsClient, stub));
}

/**
 * Build the provider wrapper for `renderHook`/headless use: a component nesting
 * `QueryClientProvider > RuntimeProvider`, plus the runtime and queryClient it
 * provides so a test can drive them directly.
 */
export function makeCoreWrapper(opts: CoreRuntimeOptions = {}): {
	wrapper: (props: { children: ReactNode }) => ReactElement;
	runtime: WsRuntime;
	queryClient: QueryClient;
} {
	const runtime = makeCoreRuntime(opts);
	const queryClient = makeQueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
	return { wrapper, runtime, queryClient };
}

/**
 * Render `ui` under the production provider nesting
 * (`QueryClientProvider > RuntimeProvider`) against a stubbed Core.
 *
 * With `path`, `ui` is mounted in an ad-hoc memory router with the two real
 * chat routes — `/` and `/thread/$threadId` — both rendering it (the
 * renderChatRoute pattern), and the live `router` is returned so a test can
 * assert the URL after a navigation.
 */
export async function renderWithCore(
	ui: ReactElement,
	opts: RenderWithCoreOptions = {},
): Promise<
	RenderResult & {
		runtime: WsRuntime;
		queryClient: QueryClient;
		router?: TestRouter;
	}
> {
	const runtime = makeCoreRuntime(opts);
	const queryClient = makeQueryClient();

	if (opts.path === undefined) {
		const result = render(
			<QueryClientProvider client={queryClient}>
				<RuntimeProvider runtime={runtime}>{ui}</RuntimeProvider>
			</QueryClientProvider>,
		);
		return { ...result, runtime, queryClient };
	}

	const rootRoute = createRootRoute({ component: Outlet });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <>{ui}</>,
	});
	const threadRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/thread/$threadId",
		component: () => <>{ui}</>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
		history: createMemoryHistory({ initialEntries: [opts.path] }),
	});
	// Resolve the initial match before render so the route's component is mounted
	// synchronously — otherwise the first paint is empty and `getBy*` would race.
	await router.load();
	const result = render(
		<QueryClientProvider client={queryClient}>
			<RuntimeProvider runtime={runtime}>
				{/* biome-ignore lint/suspicious/noExplicitAny: ad-hoc test router type */}
				<RouterProvider router={router as any} />
			</RuntimeProvider>
		</QueryClientProvider>,
	);
	return { ...result, runtime, queryClient, router };
}
