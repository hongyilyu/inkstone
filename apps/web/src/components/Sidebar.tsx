import { useParams } from "@tanstack/react-router";
import { Check, Copy, Library, Plus, Search, X } from "lucide-react";
import { NavShell, navRow } from "@/components/ui/nav-shell";
import { useCopyToClipboard } from "@/lib/hooks/useCopyToClipboard";
import { useThreads } from "@/lib/hooks/useThreads";
import { openCommand } from "@/store/command";
import { cn } from "../lib/utils.js";

export function Sidebar({
	onOpenLibrary,
	onOpenSettings,
	onOpenThread,
	onNewChat,
}: {
	onOpenLibrary?: () => void;
	onOpenSettings?: () => void;
	onOpenThread?: (threadId: string) => void;
	onNewChat?: () => void;
} = {}) {
	// The focused Thread is the route (ADR-0042); read it to mark the current row.
	const { threadId } = useParams({ strict: false });
	const focusedThreadId = threadId ?? null;

	// Reads via TanStack Query; live stream stays on store+bridge (ADR-0020).
	const { data, isPending, isError } = useThreads();

	const threads = data?.threads ?? [];
	const groups = groupByRecency(threads);

	return (
		<NavShell as="aside" ariaLabel="Sidebar" onOpenSettings={onOpenSettings}>
			<div className="flex flex-col gap-0.5">
				<button
					type="button"
					onClick={onOpenLibrary}
					className={cn(navRow, "w-full")}
				>
					<Library className="size-4 shrink-0" aria-hidden />
					Library
				</button>
				<button
					type="button"
					onClick={openCommand}
					className={cn(navRow, "w-full")}
				>
					<Search className="size-4 shrink-0" aria-hidden />
					<span className="flex-1 text-left">Search</span>
					<kbd className="rounded border border-sidebar-foreground/15 px-1.5 py-0.5 font-medium font-sans text-[10px] text-sidebar-foreground/50">
						⌘K
					</kbd>
				</button>
			</div>

			<div className="mx-3 my-3 border-border border-t" />

			<button
				type="button"
				onClick={onNewChat}
				className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg bg-secondary px-3 text-left font-semibold text-secondary-foreground text-sm transition-colors hover:bg-[color-mix(in_oklab,var(--primary)_12%,var(--secondary))] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
			>
				<Plus className="size-4 shrink-0" aria-hidden />
				New Chat
			</button>

			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{isError ? (
					// A failed `thread/list` (Core down, WS dropped) must NOT read as a
					// genuinely empty workspace — a returning user with real threads would
					// be told their conversations vanished. Show an honest load-failure.
					<p className="px-3 pt-3 text-muted-foreground text-xs">
						Couldn't load your conversations. Check that Inkstone is running.
					</p>
				) : isPending ? (
					// Fetch in flight: stay quiet rather than flashing the empty copy.
					<p className="px-3 pt-3 text-muted-foreground text-xs">Loading…</p>
				) : threads.length === 0 ? (
					<p className="px-3 pt-3 text-muted-foreground text-xs">
						No threads yet.
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
												onClick={() => onOpenThread?.(item.id)}
												aria-current={isCurrent ? "true" : undefined}
												// Long titles clip with CSS `truncate`; a native tooltip
												// reveals the full prompt on hover without a layout shift.
												title={item.title}
												className={cn(
													"h-full min-w-0 flex-1 cursor-pointer truncate rounded-lg py-0 pr-3 pl-[18px] text-left text-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
													isCurrent
														? "font-semibold text-secondary-foreground"
														: "text-sidebar-foreground",
												)}
											>
												{item.title}
											</button>
											<CopyThreadIdButton id={item.id} title={item.title} />
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

/** The per-row "copy thread id" control: writes the id to the clipboard and
 * flips to a checkmark for ~1.5s so the click has visible confirmation (without
 * this, nothing changed on copy and the user couldn't tell it worked). Reuses
 * {@link useCopyToClipboard} so the checkmark only shows on a write that actually
 * succeeded — a denied/unavailable clipboard shows the X, never a fake success.
 * The aria-label stays `Copy thread id for <title>` so existing tests/e2e
 * selectors and screen-reader users keep their stable name. */
function CopyThreadIdButton({ id, title }: { id: string; title: string }) {
	const { copied, failed, copy } = useCopyToClipboard(1500);
	return (
		<button
			type="button"
			aria-label={`Copy thread id for ${title}`}
			title={copied ? "Copied" : failed ? "Couldn't copy" : "Copy thread id"}
			onClick={() => {
				void copy(id);
			}}
			className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-foreground/80 opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
		>
			{copied ? (
				<Check className="size-3.5 text-primary" aria-hidden />
			) : failed ? (
				<X className="size-3.5 text-destructive" aria-hidden />
			) : (
				<Copy className="size-3.5" aria-hidden />
			)}
			{/* Text-content live region so screen readers announce the outcome (an
			    icon swap alone is a sighted-only cue; mirrors CopyButton). */}
			<span className="sr-only" role="status">
				{copied ? "Copied" : failed ? "Couldn't copy" : ""}
			</span>
		</button>
	);
}

type Thread = { id: string; title: string; last_activity_at: number };

/** Buckets threads by recency (newest first) into Today / Yesterday / Earlier this week / Older on local-calendar-day boundaries; empty groups dropped. */
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
