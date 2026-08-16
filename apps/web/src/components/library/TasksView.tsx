import type { TickTickTaskRow } from "@inkstone/protocol";
import { AlertTriangle, ListTodo, RefreshCw } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils.js";

// The Web Tasks surface (external-task-views A2/S2). Presentational — the route
// owns the `useTickTick` hook (status-first + reconnect protocol) and passes
// the resolved view here, so this renders without a runtime and is unit-tested
// directly. NOT linked in nav (dev flag): reachable only at /library/tasks.

/** A task's due tuple rendered for display: an all-day date, or the timed
 * instant with its zone (S1a: one due tuple, never a bare instant). BOTH use
 * `due.time_zone` — an all-day date rendered in UTC would show the previous
 * calendar day for a positive-offset zone (e.g. Asia/Shanghai), so the local
 * zone is the only correct frame. */
function DueLabel({ due }: { due: NonNullable<TickTickTaskRow["due"]> }) {
	// TickTick's wire values are looser than Intl/Date accept (CodeRabbit #336):
	// offsets come as non-ISO `+0000` (normalize to `+00:00` for `Date`) and the
	// zone can be absent/empty (pass `undefined`, not `""` — an empty zone throws).
	const date = new Date(due.date.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
	const timeZone = due.time_zone || undefined;
	const text = due.is_all_day
		? date.toLocaleDateString(undefined, { timeZone })
		: date.toLocaleString(undefined, { timeZone });
	return <span className="shrink-0 text-muted-foreground text-xs">{text}</span>;
}

function TaskRow({ task }: { task: TickTickTaskRow }) {
	const done = task.checklist_items.filter((i) => i.done).length;
	return (
		<li
			data-testid="ticktick-task"
			className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm hover:bg-secondary/40"
		>
			<span className="min-w-0 flex-1 truncate text-foreground">
				{task.title}
			</span>
			{task.checklist_items.length > 0 && (
				<span className="shrink-0 text-muted-foreground text-xs">
					{done}/{task.checklist_items.length}
				</span>
			)}
			{task.tags.map((tag) => (
				<span
					key={tag}
					className="shrink-0 rounded bg-secondary/60 px-1.5 py-0.5 text-muted-foreground text-xs"
				>
					{tag}
				</span>
			))}
			<span className="shrink-0 text-muted-foreground text-xs">
				{task.list_name ?? "unnamed list"}
			</span>
			{task.due && <DueLabel due={task.due} />}
		</li>
	);
}

export interface TasksViewProps {
	readonly connected: boolean;
	readonly statusResolved: boolean;
	readonly statusError: boolean;
	readonly rows: readonly TickTickTaskRow[];
	readonly sourceLimitReached: boolean;
	/** A first task read that failed with NO rows to show → the error state. */
	readonly tasksInitialError: boolean;
	/** A background refetch failed but the last-good rows are still held → keep
	 * rendering them with a stale indicator (A2 failure semantics). */
	readonly tasksStaleError: boolean;
	readonly tasksLoading: boolean;
	/** Manual refresh (A2, review R12 #4): re-resolves status + re-reads tasks.
	 * Doubles as the retry affordance on the error states. */
	readonly refresh: () => void;
	readonly refreshing: boolean;
}

/** The Tasks surface body. Renders the not-connected / status-error /
 * initial-error / loading states, the truncation warning when TickTick returned
 * its 200-item ceiling, a STALE indicator when a background refetch failed (the
 * rows are still shown), and the rows — with a LOCAL title filter (A2: any
 * filtering the UI offers is display-only over the one fetched result). */
export function TasksView({
	connected,
	statusResolved,
	statusError,
	rows,
	sourceLimitReached,
	tasksInitialError,
	tasksStaleError,
	tasksLoading,
	refresh,
	refreshing,
}: TasksViewProps) {
	const [filter, setFilter] = useState("");

	const retry = (
		<button
			type="button"
			onClick={refresh}
			className="mt-2 rounded-lg border border-secondary/50 px-3 py-1 text-foreground text-sm hover:bg-secondary/40"
		>
			Retry
		</button>
	);

	// A status READ that failed (couldn't reach Core) is an error — distinct from
	// a resolved `not_connected` state and from an empty task list.
	if (statusError) {
		return (
			<div
				className="p-6 text-destructive text-sm"
				data-testid="ticktick-error"
			>
				Couldn't reach TickTick. Check that Inkstone is running, then retry.
				{retry}
			</div>
		);
	}
	if (statusResolved && !connected) {
		return (
			<div
				className="p-6 text-muted-foreground text-sm"
				data-testid="ticktick-disconnected"
			>
				TickTick is not connected. Provision a credential file and restart
				Inkstone.
			</div>
		);
	}
	// A FIRST task read that failed with nothing cached → the error state. A
	// failed BACKGROUND refetch (rows present) falls through and keeps the rows.
	if (tasksInitialError) {
		return (
			<div
				className="p-6 text-destructive text-sm"
				data-testid="ticktick-error"
			>
				Couldn't reach TickTick. Check that Inkstone is running, then retry.
				{retry}
			</div>
		);
	}

	const needle = filter.trim().toLowerCase();
	const visible = needle
		? rows.filter((t) => t.title.toLowerCase().includes(needle))
		: rows;

	return (
		<div className="flex h-full flex-col gap-3 p-6">
			<header className="flex items-center gap-2">
				<ListTodo aria-hidden className="size-5 text-muted-foreground" />
				<h1 className="font-medium text-foreground">Tasks</h1>
				<button
					type="button"
					aria-label="Refresh tasks"
					data-testid="ticktick-refresh"
					onClick={refresh}
					disabled={refreshing}
					className="ml-auto rounded-lg p-1.5 text-muted-foreground hover:bg-secondary/40 disabled:opacity-50"
				>
					<RefreshCw
						aria-hidden
						className={cn("size-4", refreshing && "animate-spin")}
					/>
				</button>
			</header>

			<input
				type="search"
				aria-label="Filter tasks"
				placeholder="Filter…"
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				className="w-full max-w-sm rounded-lg border border-secondary/50 bg-transparent px-3 py-1.5 text-sm"
			/>

			{sourceLimitReached && (
				<div
					data-testid="ticktick-truncation-warning"
					className={cn(
						"flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
						"bg-amber-500/10 text-amber-700 dark:text-amber-400",
					)}
				>
					<AlertTriangle aria-hidden className="size-4 shrink-0" />
					TickTick returned its 200-item limit; this view may be incomplete.
				</div>
			)}

			{tasksStaleError && (
				<div
					data-testid="ticktick-stale-warning"
					className={cn(
						"flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
						"bg-amber-500/10 text-amber-700 dark:text-amber-400",
					)}
				>
					<AlertTriangle aria-hidden className="size-4 shrink-0" />
					Couldn't refresh from TickTick; showing the last-loaded tasks.
				</div>
			)}

			{tasksLoading || !statusResolved ? (
				// `!statusResolved` here is the STATUS-PENDING phase (status-error and
				// resolved-disconnected are handled above): show loading, never a false
				// "No tasks." while the first status read is still in flight (review M5).
				<p className="text-muted-foreground text-sm">Loading tasks…</p>
			) : visible.length === 0 ? (
				<p className="text-muted-foreground text-sm">No tasks.</p>
			) : (
				<ul aria-label="Tasks" className="flex flex-col gap-1">
					{visible.map((task) => (
						<TaskRow key={task.id} task={task} />
					))}
				</ul>
			)}
		</div>
	);
}
