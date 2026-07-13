import type {
	EntityMutateParams,
	EntityMutateResult,
	EntityRow,
} from "@inkstone/protocol";
import {
	stubWsClient,
	WsClient,
	type WsClientService,
	type WsError,
} from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { makeWsLayer, RuntimeProvider, type WsRuntime } from "@/runtime";

// The single-entry render harness for Web Client view tests: internalizes the
// stubWsClient → Layer → ManagedRuntime → QueryClient → provider-nesting
// boilerplate every test file used to re-derive. Seed data rides in as plain
// wire rows (see ./rows.ts); anything a test drives beyond reads goes through
// `overrides`, which always wins over the seeds.
//
// The harness deliberately never disposes the runtimes it creates — this
// mirrors production's RuntimeProvider, and the stub layers (Layer.succeed)
// carry no finalizers; wsConfig-mode tests that need teardown can dispose the
// returned runtime themselves.

/** The suite's QueryClient: reads never go stale on their own (matching
 * production's `staleTime: Infinity` in main.tsx) and never retry, so a failing
 * read settles into `isError` immediately instead of hanging on retry backoff. */
export function makeQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { staleTime: Number.POSITIVE_INFINITY, retry: false },
		},
	});
}

/** Seed + override surface shared by {@link makeCoreRuntime} and friends. */
export interface CoreRuntimeOptions {
	/** `entity/list` seed rows, keyed by entity type; unlisted types serve `[]`. */
	entities?: Readonly<Record<string, ReadonlyArray<EntityRow>>>;
	/** Explicit member stubs — spread LAST, so a caller override always wins. */
	overrides?: Partial<WsClientService>;
}

export interface RenderWithCoreOptions extends CoreRuntimeOptions {
	/** When given, mount a memory router at this location with the two chat
	 * routes (`/` and `/thread/$threadId`) both rendering `ui`. */
	path?: string;
	/** Injection seam: a test-owned QueryClient (e.g. pre-seeded via
	 * `setQueryData`) used instead of a fresh `makeQueryClient()`. */
	queryClient?: QueryClient;
	/** When given, back the runtime with the REAL `WsClientLive` layer over this
	 * URL instead of a stub — the `RuntimeProvider config=` replacement. The
	 * layer is lazy, so nothing dials the (dead) URL until a verb runs;
	 * combining this with seeds or `overrides` throws. */
	wsConfig?: { readonly url: string };
}

/** The ad-hoc memory router shape tests assert against. */
export interface TestRouter {
	state: { location: { pathname: string; search: unknown } };
}

/**
 * Build a stubbed {@link WsRuntime}: `listEntities` serves the seeded rows by
 * type (empty for unlisted types), `getBacklinks` serves empty sets, and
 * `subscribeRun` streams nothing. Every other verb keeps stubWsClient's loud
 * `Effect.die` default.
 */
export function makeCoreRuntime(opts: CoreRuntimeOptions = {}): WsRuntime {
	const stub = stubWsClient({
		listEntities: (type) =>
			Effect.succeed({ entities: opts.entities?.[type] ?? [] }),
		getBacklinks: () => Effect.succeed({ mentioned_in: [], linked_todos: [] }),
		subscribeRun: () => Stream.empty,
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
 * chat routes — `/` and `/thread/$threadId` — both rendering it, and the live
 * `router` is returned (non-optional, per the overload) so a test can assert
 * the URL after a navigation.
 */
export async function renderWithCore(
	ui: ReactElement,
	opts: RenderWithCoreOptions & { path: string },
): Promise<
	RenderResult & {
		runtime: WsRuntime;
		queryClient: QueryClient;
		router: TestRouter;
	}
>;
export async function renderWithCore(
	ui: ReactElement,
	opts?: RenderWithCoreOptions,
): Promise<
	RenderResult & {
		runtime: WsRuntime;
		queryClient: QueryClient;
		router?: TestRouter;
	}
>;
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
	if (
		opts.wsConfig !== undefined &&
		(opts.entities !== undefined || opts.overrides !== undefined)
	) {
		throw new Error(
			"renderWithCore: wsConfig mode uses the real WsClientLive — entities/overrides are not applied; pass one or the other",
		);
	}
	const runtime =
		opts.wsConfig !== undefined
			? ManagedRuntime.make(makeWsLayer(opts.wsConfig))
			: makeCoreRuntime(opts);
	const queryClient = opts.queryClient ?? makeQueryClient();

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

/**
 * Render an entity editor under the shared Core harness: `entityMutate`
 * (defaulting to a canned success) is the only stubbed request verb — others
 * die loudly — while the harness serves empty entity/backlink/run-event reads.
 */
export function renderEntityEditor<P extends Record<string, unknown>>(
	Editor: (props: P) => ReactElement,
	props: P,
	entityMutate: (
		params: EntityMutateParams,
	) => Effect.Effect<EntityMutateResult, WsError> = () =>
		Effect.succeed({ entity_id: "01900000-0000-7000-8000-000000000099" }),
) {
	return renderWithCore(<Editor {...props} />, { overrides: { entityMutate } });
}
