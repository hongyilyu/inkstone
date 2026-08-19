import type {
	TickTickStatusResult,
	TickTickTasksListResult,
} from "@inkstone/protocol";
import { type ConnectionStatus, WsClient } from "@inkstone/ui-sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect, Fiber, Stream } from "effect";
import { useCallback, useEffect, useState } from "react";
import { useRuntime } from "@/runtime";

// The Web lane's TanStack integration (external-task-views A2). The connection
// ID is the SOLE task-query key: the fixed Core read (`{"status":[0]}` + kind
// filtering) means one task query per connection, and any list/tag/date
// filtering the Tasks UI offers is display-only, applied locally over that one
// result. The reconnect purge is app-lifetime in `TickTickReconnectSync` (F2);
// the hook here only reads.

/** `["ticktick","tasks",<connectionId>]` — the task query key. The id alone
 * keys it; a restart mints a new id (A5), so account B's rows can never land
 * under account A's key. */
const tasksKey = (connectionId: string) =>
	["ticktick", "tasks", connectionId] as const;

export const TASKS_KEY_PREFIX = ["ticktick", "tasks"] as const;
const STATUS_KEY = ["ticktick", "status"] as const;

/** Whether the CURRENT cached Tasks read is at TickTick's 200-item source
 * limit (ticktick-writes W-A5): the created card's inline caveat reads the
 * cache only — a display hint, never a fetch. `false` when no task query has
 * resolved. */
export function readTasksAtSourceLimit(queryClient: {
	getQueriesData: (filters: {
		queryKey: readonly unknown[];
	}) => Array<[unknown, unknown]>;
}): boolean {
	return queryClient
		.getQueriesData({ queryKey: TASKS_KEY_PREFIX })
		.some(([, data]) => {
			return (
				typeof data === "object" &&
				data !== null &&
				(data as TickTickTasksListResult).source_limit_reached === true
			);
		});
}

/** Split a failed task read into an INITIAL failure (no successful fetch yet —
 * `data` is `undefined`) vs. a STALE-refetch failure (a prior fetch's data,
 * possibly an empty list, is retained by TanStack through the error). Keyed on
 * `data === undefined`, NOT row count (review #4): a successful fetch of a
 * genuinely empty account retains `{tasks: []}`, so its later refetch failure is
 * STALE — keeping the empty view with an error hint — never a full initial-error
 * screen. */
export function classifyTasksError(
	isError: boolean,
	data: TickTickTasksListResult | undefined,
) {
	return {
		tasksInitialError: isError && data === undefined,
		tasksStaleError: isError && data !== undefined,
	};
}

/** App-lifetime WS-reconnect sync for the Web Tasks lane (A2, review F2). It MUST
 * mount at the app ROOT, not inside the route: a Core restart (account swap) can
 * happen while the Tasks view is UNMOUNTED, and a route-local effect would miss
 * it — the remount would then trust the infinitely-fresh stale status/tasks cache
 * and render account A under connection B. On a real RECONNECT edge
 * (`(reconnecting|disconnected) → connected`, NOT a mount's replayed `connected`
 * — ADR-0051 `.changes`) it drops every cached task query and `resetQueries`
 * status, so the next status read mints the fresh id and the task read re-keys to
 * the current account. Renders nothing. */
export function TickTickReconnectSync(): null {
	const runtime = useRuntime();
	const queryClient = useQueryClient();

	useEffect(() => {
		const program = Effect.flatMap(WsClient, (client) => {
			let prev: ConnectionStatus | undefined;
			return Stream.runForEach(client.connectionStatus(), (state) =>
				Effect.sync(() => {
					const reconnected =
						prev !== undefined && prev !== "connected" && state === "connected";
					prev = state;
					if (reconnected) {
						queryClient.removeQueries({ queryKey: TASKS_KEY_PREFIX });
						void queryClient.resetQueries({ queryKey: STATUS_KEY });
					}
				}),
			);
		});
		const fiber = runtime.runFork(program);
		return () => {
			runtime.runFork(Fiber.interrupt(fiber));
		};
	}, [runtime, queryClient]);

	return null;
}

/** The Web Tasks surface's data (A2). Status is its own query on the global
 * staleTime; its `connection_id` is the SOLE task-query key. The reconnect purge
 * lives app-lifetime in {@link TickTickReconnectSync} (a route-local one would
 * miss a reconnect while Tasks is unmounted), so this hook only READS — a plain
 * focus refetches the task list (60s staleTime), never status, and a plain mount
 * purges nothing. After a reconnect reset, `connectionId` is `undefined` until the
 * fresh id resolves, so the task read can never fire under a stale account's key. */
export function useTickTick() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	const [manualRefreshing, setManualRefreshing] = useState(false);

	const readStatus = useCallback(
		() =>
			runtime.runPromise(
				Effect.flatMap(WsClient, (client) => client.tickTickStatus()),
			),
		[runtime],
	);
	const readTasks = useCallback(
		() =>
			runtime.runPromise(
				Effect.flatMap(WsClient, (client) => client.tickTickTasksList()),
			),
		[runtime],
	);

	const status = useQuery({
		queryKey: STATUS_KEY,
		// Uses the global `staleTime: Infinity` (main.tsx). The account can only
		// change across a Core restart, and the WS `connected` transition below
		// RESETS this query then — NOT every window focus (review M4). A plain
		// focus must never refetch status and blank the Tasks surface.
		queryFn: readStatus,
	});

	// The connection ID keys the task read. It is `undefined` until status
	// resolves `connected`; the app-lifetime `TickTickReconnectSync` reset clears
	// `status.data` (→ `undefined` here → the task read disables) while a reconnect
	// re-resolves, so a task fetch can never run under a stale id. No `isFetching`
	// term — that dropped the id on every focus refetch and thrashed the cache (M4).
	const connectionId =
		status.data?.state === "connected" ? status.data.connection_id : undefined;

	const tasks = useQuery({
		queryKey: connectionId ? tasksKey(connectionId) : TASKS_KEY_PREFIX,
		enabled: connectionId !== undefined,
		staleTime: 60_000,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
		queryFn: readTasks,
	});

	const refresh = useCallback(() => {
		setManualRefreshing(true);
		queryClient.removeQueries({ queryKey: TASKS_KEY_PREFIX });

		void queryClient
			.resetQueries({ queryKey: STATUS_KEY, exact: true })
			.then(() => {
				const fresh =
					queryClient.getQueryData<TickTickStatusResult>(STATUS_KEY);
				if (fresh?.state !== "connected") return;
				return queryClient.fetchQuery({
					queryKey: tasksKey(fresh.connection_id),
					queryFn: readTasks,
					staleTime: 0,
				});
			})
			.catch(() => undefined)
			.finally(() => {
				setManualRefreshing(false);
			});
	}, [queryClient, readTasks]);

	// #4: a FAILED background refetch keeps the last-good rows (TanStack retains
	// `data` on error), so distinguish it from an initial failure with no rows.
	const rows = tasks.data?.tasks ?? [];
	return {
		connected: status.data?.state === "connected",
		statusResolved: status.isSuccess,
		// A status read that FAILED (not merely disconnected) — the surface shows
		// an error, not an empty "No tasks." list.
		statusError: status.isError,
		rows,
		sourceLimitReached: tasks.data?.source_limit_reached ?? false,
		// Initial-vs-stale failure split (review #4): see `classifyTasksError`.
		...classifyTasksError(tasks.isError, tasks.data),
		tasksLoading: tasks.isLoading && connectionId !== undefined,
		// Status-first manual refresh: task cache purge → fresh status → fresh-key
		// task read. A disabled task observer is never refetched.
		refresh,
		refreshing: manualRefreshing || status.isFetching || tasks.isFetching,
	};
}
