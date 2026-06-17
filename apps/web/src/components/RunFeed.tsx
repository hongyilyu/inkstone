import type { RunHistoryItem } from "@inkstone/protocol";
import { History } from "lucide-react";
import { useMemo } from "react";
import { useRunHistory } from "@/lib/hooks/useRunHistory";
import {
	formatRunTime,
	RUN_HISTORY_BUCKET_ORDER,
	RUN_HISTORY_TONE_CLASS,
	RUN_HISTORY_VIEWS,
	runHistoryBucket,
} from "@/lib/runHistory";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button.js";

/**
 * The recent-Runs feed (ADR-0028 as-built): a calm, recency-grouped list of the
 * agent's recent Runs, backed by the live `run/get_history` reader. Each row
 * shows the owning Thread's title plus a label/icon for the Run's latest
 * lifecycle milestone; clicking a row opens that Run's Thread. Replaces the
 * visual-only ActivityRail (ADR-0010) in the chat surface's right rail.
 */
export function RunFeed({
	onOpenThread,
}: {
	onOpenThread: (threadId: string) => void;
}) {
	const { data: runs, isPending, isError, refetch } = useRunHistory();

	const groups = useMemo(() => {
		if (!runs) return [];
		const byBucket = new Map<string, RunHistoryItem[]>();
		for (const run of runs) {
			const bucket = runHistoryBucket(run.at);
			const list = byBucket.get(bucket);
			if (list) list.push(run);
			else byBucket.set(bucket, [run]);
		}
		return RUN_HISTORY_BUCKET_ORDER.filter((b) => byBucket.has(b)).map((b) => ({
			label: b,
			// biome-ignore lint/style/noNonNullAssertion: filtered to present buckets.
			runs: byBucket.get(b)!,
		}));
	}, [runs]);

	return (
		<aside
			aria-label="Recent runs"
			className="flex h-full flex-col overflow-x-hidden bg-sidebar text-sidebar-foreground text-sm"
		>
			<div className="flex h-14 shrink-0 items-center px-4 font-semibold text-muted-foreground text-xs">
				Runs
			</div>

			<div className="flex flex-1 flex-col overflow-y-auto pb-3">
				{isPending ? (
					<FeedSkeleton />
				) : isError ? (
					<FeedError onRetry={() => void refetch()} />
				) : groups.length === 0 ? (
					<FeedEmpty />
				) : (
					groups.map((group) => (
						<section key={group.label}>
							<h2 className="sticky top-0 z-10 bg-sidebar px-4 pt-3 pb-1 font-semibold text-muted-foreground text-xs">
								{group.label}
							</h2>
							<ul className="flex flex-col gap-0.5 px-2">
								{group.runs.map((run) => (
									<RunRow
										key={run.run_id}
										run={run}
										onOpen={() => onOpenThread(run.thread_id)}
									/>
								))}
							</ul>
						</section>
					))
				)}
			</div>
		</aside>
	);
}

function RunRow({ run, onOpen }: { run: RunHistoryItem; onOpen: () => void }) {
	const view = RUN_HISTORY_VIEWS[run.kind];
	const Icon = view.icon;
	return (
		<li>
			<button
				type="button"
				onClick={onOpen}
				className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-primary/10"
			>
				<Icon
					className={cn(
						"mt-0.5 size-3.5 shrink-0",
						RUN_HISTORY_TONE_CLASS[view.tone],
					)}
					aria-hidden
				/>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sidebar-foreground">
						{run.title}
					</span>
					<span className="block truncate text-muted-foreground text-xs">
						{view.label} · {formatRunTime(run.at)}
					</span>
				</span>
			</button>
		</li>
	);
}

/** Loading: skeleton rows, not a centred spinner (DESIGN.md "show the state"). */
function FeedSkeleton() {
	return (
		<div
			className="flex flex-col gap-0.5 px-2 pt-3"
			data-testid="run-feed-skeleton"
			aria-hidden
		>
			{[0, 1, 2, 3].map((i) => (
				<div key={i} className="flex items-start gap-2 px-2 py-1.5">
					<div className="mt-0.5 size-3.5 shrink-0 animate-pulse rounded-full bg-foreground/10" />
					<div className="min-w-0 flex-1 space-y-1.5">
						<div className="h-3 w-3/4 animate-pulse rounded bg-foreground/10" />
						<div className="h-2.5 w-2/5 animate-pulse rounded bg-foreground/5" />
					</div>
				</div>
			))}
		</div>
	);
}

/** Empty: teach the surface, don't say "nothing here" (DESIGN.md). */
function FeedEmpty() {
	return (
		<div className="flex flex-col items-center gap-1.5 px-6 pt-10 text-center">
			<History className="size-5 text-muted-foreground/70" aria-hidden />
			<p className="font-medium text-sidebar-foreground text-sm">No runs yet</p>
			<p className="text-muted-foreground text-xs">
				Runs appear here as you chat.
			</p>
		</div>
	);
}

/** Error: a calm read-failure, not an alarm — Core is just unreachable. */
function FeedError({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="flex flex-col items-center gap-2 px-6 pt-10 text-center">
			<p className="text-muted-foreground text-xs">
				Couldn't load run history.
			</p>
			<Button variant="sidebar-item" size="xs" onClick={onRetry}>
				Try again
			</Button>
		</div>
	);
}
