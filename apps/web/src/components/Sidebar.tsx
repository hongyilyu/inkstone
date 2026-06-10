import { Copy, Library, Plus } from "lucide-react";
import { useState } from "react";
import { NavShell, navRow } from "@/components/ui/nav-shell";
import { useThreads } from "@/lib/hooks/useThreads";
import {
	clearFocusedThread,
	setFocusedThread,
	useFocusedThreadId,
} from "@/store/chat";
import { cn } from "../lib/utils.js";
import { SearchField } from "./ui/search-field.js";

export function Sidebar({
	onOpenLibrary,
	onOpenSettings,
}: {
	onOpenLibrary?: () => void;
	onOpenSettings?: () => void;
} = {}) {
	const focusedThreadId = useFocusedThreadId();
	const [query, setQuery] = useState("");

	// Reads run on the runtime via TanStack Query (loading/error/success free);
	// the live stream stays on the store+bridge (ADR-0020). `data` is undefined
	// while loading or on error → render an empty list, never throw.
	const { data } = useThreads();

	const threads = data?.threads ?? [];
	const filtered = threads.filter((t) =>
		t.title.toLowerCase().includes(query.trim().toLowerCase()),
	);
	const groups = groupByRecency(filtered);

	const newChat = () => {
		clearFocusedThread();
		setQuery("");
	};

	return (
		<NavShell as="aside" ariaLabel="Sidebar" onOpenSettings={onOpenSettings}>
			<div className="flex flex-col gap-0.5">
				<button
					type="button"
					onClick={newChat}
					className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg bg-secondary px-3 text-left font-semibold text-secondary-foreground text-sm transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_12%,var(--secondary))]"
				>
					<Plus className="size-4 shrink-0" aria-hidden />
					New Chat
				</button>
				<button
					type="button"
					onClick={onOpenLibrary}
					className={cn(navRow, "w-full")}
				>
					<Library className="size-4 shrink-0" aria-hidden />
					Library
				</button>
			</div>

			<div className="mx-3 my-3 border-border border-t" />

			<SearchField
				variant="divider"
				tone="sidebar"
				aria-label="Search your threads"
				placeholder="Search your threads…"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
			/>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{filtered.length === 0 ? (
					<p className="px-3 pt-3 text-muted-foreground text-xs">
						No threads match.
					</p>
				) : (
					groups.map((group) => (
						<section key={group.label}>
							<h2 className="sticky top-0 z-10 bg-sidebar px-3 pt-3 pb-1 font-semibold text-muted-foreground text-xs">
								{group.label}
							</h2>
							<ul className="flex flex-col gap-1">
								{group.threads.map((item) => {
									const isCurrent = item.id === focusedThreadId;
									return (
										<li
											key={item.id}
											className={cn(
												"group relative flex h-10 items-center rounded-lg pr-1 transition-colors",
												isCurrent ? "bg-secondary/70" : "hover:bg-primary/10",
											)}
										>
											{isCurrent && (
												<span
													aria-hidden="true"
													className="pointer-events-none absolute top-1/2 left-2 size-[5px] -translate-y-1/2 rounded-full bg-primary"
												/>
											)}
											<button
												type="button"
												onClick={() => setFocusedThread(item.id)}
												aria-current={isCurrent ? "true" : undefined}
												className={cn(
													"h-full min-w-0 flex-1 cursor-pointer truncate rounded-lg py-0 pr-3 pl-[18px] text-left text-sm",
													isCurrent
														? "font-semibold text-secondary-foreground"
														: "text-sidebar-foreground",
												)}
											>
												{item.title}
											</button>
											<button
												type="button"
												aria-label={`Copy thread id for ${item.title}`}
												title="Copy thread id"
												onClick={() => {
													void navigator.clipboard?.writeText(item.id);
												}}
												className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/80 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
											>
												<Copy className="size-3.5" />
											</button>
										</li>
									);
								})}
							</ul>
						</section>
					))
				)}
			</div>
		</NavShell>
	);
}

type Thread = { id: string; title: string; last_activity_at: number };

/**
 * Bucket threads by how recently they were active, newest group first. Labels
 * read like a person describing time ("Today", "Earlier this week") rather than
 * a fixed window ("Last 30 days"). Boundaries are local calendar days: today,
 * yesterday, the rest of the last 7 days, then everything older. Empty groups
 * are dropped so the sidebar only shows headers that have threads.
 */
function groupByRecency(
	threads: readonly Thread[],
	now: number = Date.now(),
): { label: string; threads: Thread[] }[] {
	const startOfToday = new Date(now).setHours(0, 0, 0, 0);
	const dayMs = 86_400_000;
	const startOfYesterday = startOfToday - dayMs;
	const startOfWeek = startOfToday - 6 * dayMs;

	const groups: { label: string; threads: Thread[] }[] = [
		{ label: "Today", threads: [] },
		{ label: "Yesterday", threads: [] },
		{ label: "Earlier this week", threads: [] },
		{ label: "Older", threads: [] },
	];

	for (const t of threads) {
		const at = t.last_activity_at;
		if (at >= startOfToday) groups[0].threads.push(t);
		else if (at >= startOfYesterday) groups[1].threads.push(t);
		else if (at >= startOfWeek) groups[2].threads.push(t);
		else groups[3].threads.push(t);
	}

	return groups.filter((g) => g.threads.length > 0);
}
