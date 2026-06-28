import { Link, useNavigate } from "@tanstack/react-router";
import {
	Film,
	HeartPulse,
	History,
	House,
	ListTodo,
	type LucideIcon,
	MessageSquareText,
	Search,
} from "lucide-react";
import { NavShell, navRow, navRowActive } from "@/components/ui/nav-shell";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import { todayHubStats } from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { openCommand } from "@/store/command";

/**
 * The four browse topics (ADR-0054). A fixed, curated set — adding one is a
 * deliberate code change, never configuration. Each dives into its own signature
 * view; GTD, Health, and Media routes are live. Timeline's route lands in a later
 * slice, so its `to` points at `/library` temporarily and the row is inert
 * until then.
 */
const TOPICS: {
	label: string;
	icon: LucideIcon;
	to: "/library" | "/library/gtd" | "/library/health" | "/library/media";
}[] = [
	{ label: "GTD", icon: ListTodo, to: "/library/gtd" },
	{ label: "Timeline", icon: History, to: "/library" },
	{ label: "Health", icon: HeartPulse, to: "/library/health" },
	{ label: "Media", icon: Film, to: "/library/media" },
];

/** Left nav for the topic-organized Workspace (ADR-0054): return-to-chat, search,
 * the Today hub with live glance counts, and the four topic dives. Replaces the
 * flat entity-type list. */
export function TopicNav() {
	const navigate = useNavigate();
	const { data, isError } = useLibraryItems();
	const items = data ?? [];
	const stats = todayHubStats(items);
	// Suppress the glance counts ONLY when the read failed AND there's no cached
	// data — a misleading `0` reads as a fake-empty workspace, while a refetch
	// error over a coherent cache keeps the real (stale-but-usable) counts.
	const countsUnknown = isError && items.length === 0;

	return (
		<NavShell
			as="nav"
			ariaLabel="Workspace"
			onOpenSettings={() => navigate({ to: "/settings/models" })}
		>
			<div className="flex flex-col gap-0.5">
				<Link to="/" className={navRow}>
					<MessageSquareText className="size-4 shrink-0" aria-hidden />
					Chat
				</Link>
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

			{/* The Today hub: a global daily landing above the topics (ADR-0054). The
			    row links to `/library`; the glance stats beneath read live counts. */}
			<Link
				to="/library"
				activeOptions={{ exact: true }}
				className={navRow}
				activeProps={{ className: cn(navRow, navRowActive) }}
			>
				<House className="size-4 shrink-0" aria-hidden />
				<span className="flex-1 truncate font-medium">Today</span>
			</Link>
			{!countsUnknown && (
				<ul className="mt-1 mb-1 ml-9 flex flex-col gap-0.5 text-sidebar-foreground/55 text-xs">
					<GlanceStat n={stats.todo} label="to do" />
					<GlanceStat n={stats.dueToday} label="due today" />
					<GlanceStat n={stats.toReview} label="to review" />
				</ul>
			)}

			<div className="mt-3 mb-1 px-3 font-medium text-[11px] text-sidebar-foreground/40 uppercase tracking-wide">
				Topics
			</div>
			<div className="flex flex-col gap-0.5">
				{TOPICS.map((topic) => {
					const Icon = topic.icon;
					return (
						<Link
							key={topic.label}
							to={topic.to}
							className={navRow}
							activeProps={{ className: cn(navRow, navRowActive) }}
						>
							<Icon className="size-4 shrink-0" aria-hidden />
							<span className="flex-1 truncate">{topic.label}</span>
						</Link>
					);
				})}
			</div>
		</NavShell>
	);
}

/** One glance stat under the Today hub: a tabular count + its label. */
function GlanceStat({ n, label }: { n: number; label: string }) {
	return <li className="tabular-nums">{`${n} ${label}`}</li>;
}
