import type {
	TickTickStatusResult,
	TickTickTasksListResult,
} from "@inkstone/protocol";
import type { ConnectionStatus } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeCoreRuntime } from "@test/test-utils/renderWithCore";
import { render, renderHook, waitFor } from "@testing-library/react";
import { Effect, Queue, Stream } from "effect";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
	classifyTasksError,
	TickTickReconnectSync,
	useTickTick,
} from "@/lib/hooks/useTickTick.js";
import { RuntimeProvider } from "@/runtime";

// The A2 reconnect protocol splits across two homes: `useTickTick` GATES the task
// read on the connection id, and the app-lifetime `TickTickReconnectSync` PURGES
// the cache on a real WS reconnect edge — NOT a mount's replayed `connected`
// (review F2/F5). Both are pinned here, deterministically (no stream timing).

function wrapper(opts: {
	status?: TickTickStatusResult;
	tasks?: TickTickTasksListResult;
	onTasksCall?: () => void;
	connectionStatus?: Stream.Stream<ConnectionStatus>;
	queryClient: QueryClient;
}) {
	const connectionStatus = opts.connectionStatus;
	const runtime = makeCoreRuntime({
		overrides: {
			tickTickStatus: () =>
				Effect.succeed(opts.status ?? { state: "not_connected" }),
			tickTickTasksList: () =>
				Effect.sync(() => {
					opts.onTasksCall?.();
					return opts.tasks ?? { tasks: [], source_limit_reached: false };
				}),
			...(connectionStatus ? { connectionStatus: () => connectionStatus } : {}),
		},
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={opts.queryClient}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
}

describe("useTickTick task-read gating", () => {
	it("gates the task read on a known connection id (never fetches while not connected)", async () => {
		let tasksCalls = 0;
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(() => useTickTick(), {
			wrapper: wrapper({
				status: { state: "not_connected" },
				onTasksCall: () => {
					tasksCalls += 1;
				},
				queryClient,
			}),
		});

		await waitFor(() => expect(result.current.statusResolved).toBe(true));
		expect(result.current.connected).toBe(false);
		// The task read is `enabled` only once an id is known — it never fired.
		expect(tasksCalls).toBe(0);
		expect(result.current.rows).toEqual([]);
	});
});

describe("TickTickReconnectSync (app-lifetime cache purge)", () => {
	it("drops task caches and resets status on a WS reconnect (disconnected→connected)", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		// Warm caches under the PRIOR account — the tab survived a Core restart.
		queryClient.setQueryData(["ticktick", "tasks", "acct-A"], {
			tasks: [
				{
					id: "old",
					title: "A's task",
					kind: "TEXT",
					priority: 0,
					tags: [],
					checklist_items: [],
				},
			],
			source_limit_reached: false,
		});
		queryClient.setQueryData(["ticktick", "status"], {
			state: "connected",
			connection_id: "acct-A",
		});

		render(<TickTickReconnectSync />, {
			wrapper: wrapper({
				// A real reconnect EDGE: a drop, then back to connected.
				connectionStatus: Stream.make(
					"reconnecting" as ConnectionStatus,
					"connected" as ConnectionStatus,
				),
				queryClient,
			}),
		});

		// The reconnect drops every task query AND resets status, so the next
		// status read mints the fresh id — account A can never render under B.
		await waitFor(() =>
			expect(
				queryClient.getQueryData(["ticktick", "tasks", "acct-A"]),
			).toBeUndefined(),
		);
		await waitFor(() =>
			expect(queryClient.getQueryData(["ticktick", "status"])).toBeUndefined(),
		);
	});

	it("leaves a warm cache intact on a plain mount replay (no prior drop)", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(["ticktick", "tasks", "acct-A"], {
			tasks: [
				{
					id: "warm",
					title: "warm task",
					kind: "TEXT",
					priority: 0,
					tags: [],
					checklist_items: [],
				},
			],
			source_limit_reached: false,
		});

		// A test-driven stream (not a canned one): first the mount replay, then —
		// only after asserting survival — a REAL reconnect edge. The eventual purge
		// proves the SAME ordered fiber consumed the replay first, so the survival
		// assertion is ordering-based, not a fixed sleep (CodeRabbit #336).
		const queue = Effect.runSync(Queue.unbounded<ConnectionStatus>());
		render(<TickTickReconnectSync />, {
			wrapper: wrapper({
				connectionStatus: Stream.fromQueue(queue),
				queryClient,
			}),
		});

		// Mount replay: a lone `connected` with NO prior non-connected state
		// (ADR-0051 `.changes` replays current on subscribe).
		await Effect.runPromise(
			Queue.offer(queue, "connected" as ConnectionStatus),
		);
		// The replay is NOT a reconnect → the warm cache survives (review F2/F5).
		expect(
			queryClient.getQueryData(["ticktick", "tasks", "acct-A"]),
		).toBeDefined();

		// Now a REAL edge through the same stream: the purge landing proves the
		// observer processed the whole ordered sequence — replay included.
		await Effect.runPromise(
			Queue.offer(queue, "reconnecting" as ConnectionStatus),
		);
		await Effect.runPromise(
			Queue.offer(queue, "connected" as ConnectionStatus),
		);
		await waitFor(() =>
			expect(
				queryClient.getQueryData(["ticktick", "tasks", "acct-A"]),
			).toBeUndefined(),
		);
	});
});

// Review #4: the initial-vs-stale split keys on `data === undefined`, not row
// count. TanStack retains the last-good `data` through a failed refetch (a
// successful fetch then a refetch failure lands `status: 'error'` with the prior
// data still present) — so a valid EMPTY fetch (`{tasks: []}`) whose refetch
// later fails is a STALE error over an empty cache, NEVER an initial one. The
// old `rows.length === 0` could not tell that empty-but-valid cache from "no data
// yet"; this classifier can.
describe("classifyTasksError (initial vs stale)", () => {
	it("classifies a failed refetch over a valid empty cache as stale, not initial", () => {
		expect(
			classifyTasksError(true, { tasks: [], source_limit_reached: false }),
		).toEqual({ tasksInitialError: false, tasksStaleError: true });
	});

	it("classifies a failure with no prior fetch as initial", () => {
		expect(classifyTasksError(true, undefined)).toEqual({
			tasksInitialError: true,
			tasksStaleError: false,
		});
	});

	it("reports neither flag when there is no error", () => {
		expect(
			classifyTasksError(false, { tasks: [], source_limit_reached: false }),
		).toEqual({ tasksInitialError: false, tasksStaleError: false });
		expect(classifyTasksError(false, undefined)).toEqual({
			tasksInitialError: false,
			tasksStaleError: false,
		});
	});
});
