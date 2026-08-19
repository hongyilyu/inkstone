import type {
	TickTickStatusResult,
	TickTickTasksListResult,
} from "@inkstone/protocol";
import type { ConnectionStatus } from "@inkstone/ui-sdk";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeCoreRuntime } from "@test/test-utils/renderWithCore";
import { act, render, renderHook, waitFor } from "@testing-library/react";
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
	statusRead?: () => Effect.Effect<TickTickStatusResult>;
	tasksRead?: () => Effect.Effect<TickTickTasksListResult>;
	onTasksCall?: () => void;
	connectionStatus?: Stream.Stream<ConnectionStatus>;
	queryClient: QueryClient;
}) {
	const connectionStatus = opts.connectionStatus;
	const reads = {
		tickTickStatus:
			opts.statusRead ??
			(() => Effect.succeed(opts.status ?? { state: "not_connected" })),
		tickTickTasksList: () =>
			Effect.suspend(() => {
				opts.onTasksCall?.();
				return (
					opts.tasksRead?.() ??
					Effect.succeed(
						opts.tasks ?? { tasks: [], source_limit_reached: false },
					)
				);
			}),
	};
	// The status stream rides only when the test drives reconnect edges.
	const runtime = makeCoreRuntime({
		overrides:
			connectionStatus === undefined
				? reads
				: { ...reads, connectionStatus: () => connectionStatus },
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={opts.queryClient}>
			<RuntimeProvider runtime={runtime}>{children}</RuntimeProvider>
		</QueryClientProvider>
	);
}

const task = (id: string, title: string) => ({
	id,
	title,
	kind: "TEXT" as const,
	priority: 0,
	tags: [],
	checklist_items: [],
});

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

	it("a retry from disconnected awaits fresh status and then fetches the fresh key", async () => {
		let statusCalls = 0;
		let tasksCalls = 0;
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(() => useTickTick(), {
			wrapper: wrapper({
				statusRead: () =>
					Effect.sync(() => {
						statusCalls += 1;
						return statusCalls === 1
							? ({ state: "not_connected" } as const)
							: ({ state: "connected", connection_id: "acct-B" } as const);
					}),
				tasksRead: () =>
					Effect.sync(() => {
						tasksCalls += 1;
						return {
							tasks: [task("b-1", "B task")],
							source_limit_reached: false,
						};
					}),
				queryClient,
			}),
		});

		await waitFor(() => expect(result.current.statusResolved).toBe(true));
		expect(result.current.connected).toBe(false);
		expect(tasksCalls).toBe(0);

		act(() => result.current.refresh());

		await waitFor(() =>
			expect(result.current.rows.map((row) => row.id)).toEqual(["b-1"]),
		);
		expect(statusCalls).toBe(2);
		expect(tasksCalls).toBe(1);
		expect(
			queryClient.getQueryData(["ticktick", "tasks", "acct-B"]),
		).toMatchObject({ tasks: [{ id: "b-1" }] });
	});

	it("clears account A immediately and waits for delayed account B status before fetching", async () => {
		let resolveFreshStatus!: (status: TickTickStatusResult) => void;
		const freshStatus = new Promise<TickTickStatusResult>((resolve) => {
			resolveFreshStatus = resolve;
		});
		let statusCalls = 0;
		let tasksCalls = 0;
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(() => useTickTick(), {
			wrapper: wrapper({
				statusRead: () => {
					statusCalls += 1;
					return statusCalls === 1
						? Effect.succeed({
								state: "connected",
								connection_id: "acct-A",
							} as const)
						: Effect.promise(() => freshStatus);
				},
				tasksRead: () =>
					Effect.sync(() => {
						tasksCalls += 1;
						return tasksCalls === 1
							? {
									tasks: [task("a-1", "A task")],
									source_limit_reached: false,
								}
							: {
									tasks: [task("b-1", "B task")],
									source_limit_reached: false,
								};
					}),
				queryClient,
			}),
		});

		await waitFor(() =>
			expect(result.current.rows.map((row) => row.id)).toEqual(["a-1"]),
		);
		expect(tasksCalls).toBe(1);

		act(() => result.current.refresh());

		await waitFor(() => expect(result.current.rows).toEqual([]));
		expect(
			queryClient.getQueryData(["ticktick", "tasks", "acct-A"]),
		).toBeUndefined();
		expect(tasksCalls).toBe(1);
		expect(result.current.refreshing).toBe(true);

		await act(async () => {
			resolveFreshStatus({
				state: "connected",
				connection_id: "acct-B",
			});
			await freshStatus;
		});

		await waitFor(() =>
			expect(result.current.rows.map((row) => row.id)).toEqual(["b-1"]),
		);
		expect(statusCalls).toBe(2);
		expect(tasksCalls).toBe(2);
		expect(
			queryClient.getQueryData(["ticktick", "tasks", "acct-A"]),
		).toBeUndefined();
		expect(
			queryClient.getQueryData(["ticktick", "tasks", "acct-B"]),
		).toMatchObject({ tasks: [{ id: "b-1" }] });
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
				connectionStatus: Stream.fromIterable<ConnectionStatus>([
					"reconnecting",
					"connected",
				]),
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
		await Effect.runPromise(Queue.offer(queue, "connected"));
		// The replay is NOT a reconnect → the warm cache survives (review F2/F5).
		expect(
			queryClient.getQueryData(["ticktick", "tasks", "acct-A"]),
		).toBeDefined();

		// Now a REAL edge through the same stream: the purge landing proves the
		// observer processed the whole ordered sequence — replay included.
		await Effect.runPromise(Queue.offer(queue, "reconnecting"));
		await Effect.runPromise(Queue.offer(queue, "connected"));
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
