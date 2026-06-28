import {
	CalendarArrowUp,
	CalendarClock,
	FolderKanban,
	Hourglass,
	Inbox,
	ListTodo,
	type LucideIcon,
	Sun,
} from "lucide-react";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	dueSoonTodos,
	inboxTodos,
	type LibraryItem,
	projectsForReview,
	scheduledTodos,
	type Todo,
	waitingTodos,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { DerivedTodoView } from "./DerivedTodoView";
import { EntityCollection } from "./EntityCollection";
import { ProjectReviewView } from "./ProjectReviewView";

/**
 * The GTD action board (ADR-0054). One signature surface that re-homes the four
 * derived workflow views (Inbox · Waiting · Scheduled · Review) — previously
 * separate `/library/*` routes — plus Today/Projects/All as in-view filters. The
 * active filter is owned by the route via `?filt=` (URL-addressable); this
 * component is controlled. Each filter renders a SHIPPED view over an EXISTING
 * predicate — no new derivation, no rebuilt list rendering.
 */
export type GtdFilter =
	| "today"
	| "inbox"
	| "waiting"
	| "scheduled"
	| "review"
	| "projects"
	| "all";

/** All active todos — the trivial active-todo filter (no new derivation). */
function allActiveTodos(all: LibraryItem[]): Todo[] {
	return all
		.filter((e): e is Todo => e.kind === "todo" && e.status === "active")
		.sort((a, b) => b.recency - a.recency);
}

/** The DerivedTodoView config for each todo-list filter — title/icon/empty copy
 * lifted verbatim from the retired derived routes. Review and Projects render
 * their own views and are handled in the body switch, not here. */
const TODO_FILTERS: Record<
	"today" | "inbox" | "waiting" | "scheduled" | "all",
	{
		title: string;
		intro: string;
		icon: LucideIcon;
		select: (all: LibraryItem[]) => Todo[];
		emptyTitle: string;
		emptyDescription: string;
	}
> = {
	today: {
		title: "Today",
		intro: "Active todos due soon — overdue and due in the next few days.",
		icon: Sun,
		select: (all) => dueSoonTodos(all),
		emptyTitle: "Nothing due",
		emptyDescription:
			"Nothing's due in the next few days. Todos with a near due date land here.",
	},
	inbox: {
		title: "Inbox",
		intro:
			"Active todos you haven't organized yet — no project, no due date, no people.",
		icon: Inbox,
		select: inboxTodos,
		emptyTitle: "Inbox zero",
		emptyDescription:
			"Nothing unsorted. New todos land here until you give them a project, a due date, or a person.",
	},
	waiting: {
		title: "Waiting",
		intro:
			"Active todos where you're waiting on someone — anything with a waiting-on person.",
		icon: Hourglass,
		select: waitingTodos,
		emptyTitle: "Nothing pending",
		emptyDescription:
			"When you mark a todo as waiting on someone, it shows up here so you can follow up.",
	},
	scheduled: {
		title: "Scheduled",
		intro:
			"Active todos you've deferred to a future date — they become available on the date shown.",
		icon: CalendarArrowUp,
		select: scheduledTodos,
		emptyTitle: "Nothing scheduled",
		emptyDescription:
			"Todos you defer to a future date show up here until they become available.",
	},
	all: {
		title: "All",
		intro: "Every active todo, newest first — across all projects and people.",
		icon: ListTodo,
		select: allActiveTodos,
		emptyTitle: "No active todos",
		emptyDescription:
			"You're all clear. Active todos appear here as you capture them.",
	},
};

/** The pill rail, in display order. Counts read the same predicates the body
 * does, so a pill's badge always matches the list it opens. */
const PILLS: { filt: GtdFilter; label: string; icon: LucideIcon }[] = [
	{ filt: "today", label: "Today", icon: Sun },
	{ filt: "inbox", label: "Inbox", icon: Inbox },
	{ filt: "waiting", label: "Waiting", icon: Hourglass },
	{ filt: "scheduled", label: "Scheduled", icon: CalendarArrowUp },
	{ filt: "review", label: "Review", icon: CalendarClock },
	{ filt: "projects", label: "Projects", icon: FolderKanban },
	{ filt: "all", label: "All", icon: ListTodo },
];

/** The count behind each pill, from the live items. */
function pillCount(filt: GtdFilter, all: LibraryItem[]): number {
	switch (filt) {
		case "today":
			return dueSoonTodos(all).length;
		case "inbox":
			return inboxTodos(all).length;
		case "waiting":
			return waitingTodos(all).length;
		case "scheduled":
			return scheduledTodos(all).length;
		case "review":
			return projectsForReview(all).length;
		case "projects":
			return all.filter(
				(e) =>
					e.kind === "project" &&
					(e.status === "active" || e.status === "on_hold"),
			).length;
		case "all":
			return allActiveTodos(all).length;
	}
}

export function GtdView({
	filt,
	onFilterChange,
	selectedId,
	onSelect,
}: {
	filt: GtdFilter;
	onFilterChange: (filt: GtdFilter) => void;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const { data } = useLibraryItems();
	const items = data ?? [];

	return (
		<section aria-label="GTD" className="flex h-full min-h-0 flex-col">
			<div
				role="tablist"
				aria-label="GTD filter"
				className="flex shrink-0 flex-wrap gap-1 px-6 pt-4 pb-3"
			>
				{PILLS.map((pill) => {
					const Icon = pill.icon;
					const active = pill.filt === filt;
					const count = pillCount(pill.filt, items);
					return (
						<button
							key={pill.filt}
							type="button"
							role="tab"
							aria-selected={active}
							onClick={() => onFilterChange(pill.filt)}
							className={cn(
								"inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-sm transition-colors",
								"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
								active
									? "bg-secondary text-foreground"
									: "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
							)}
						>
							<Icon className="size-4 shrink-0" aria-hidden />
							{pill.label}
							{count > 0 ? (
								<span className="tabular-nums text-muted-foreground text-xs">
									{count}
								</span>
							) : null}
						</button>
					);
				})}
			</div>

			<div className="min-h-0 flex-1">
				<GtdBody filt={filt} selectedId={selectedId} onSelect={onSelect} />
			</div>
		</section>
	);
}

/** The in-view body for the active filter — a shipped view over an existing
 * predicate. Review and Projects render their own bespoke views; everything else
 * is a `DerivedTodoView` over a GTD predicate. */
function GtdBody({
	filt,
	selectedId,
	onSelect,
}: {
	filt: GtdFilter;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	if (filt === "review") {
		return <ProjectReviewView selectedId={selectedId} onSelect={onSelect} />;
	}
	if (filt === "projects") {
		return (
			<EntityCollection
				kind="project"
				selectedId={selectedId}
				onSelect={onSelect}
			/>
		);
	}
	const view = TODO_FILTERS[filt];
	return (
		<DerivedTodoView {...view} selectedId={selectedId} onSelect={onSelect} />
	);
}
