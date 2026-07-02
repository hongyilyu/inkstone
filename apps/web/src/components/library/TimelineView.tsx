import { FolderKanban, History, type LucideIcon, User } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import { formatDay, KIND_META } from "@/lib/libraryItems";
import { buildTimeline, type TimelineChip } from "@/lib/timeline";
import { cn } from "@/lib/utils.js";
import { FocusedEntityRail } from "./FocusedEntityRail.js";

/**
 * The Timeline topic surface (ADR-0054 §4): a day-grouped chronological feed of
 * Journal Entries with the People/Projects each touches as link-chips. Pure
 * presentation over `buildTimeline(useLibraryItems())` — no new read. The active
 * type tab is owned by the route via `?filter=` (URL-addressable); this component
 * is controlled.
 */
export type TimelineFilter = "all" | "journal" | "person" | "project";

/** The in-view type tabs, in display order. */
const TABS: { filter: TimelineFilter; label: string; icon: LucideIcon }[] = [
	{ filter: "all", label: "All", icon: History },
	{ filter: "journal", label: "Journal", icon: KIND_META.journal_entry.icon },
	{ filter: "person", label: "People", icon: User },
	{ filter: "project", label: "Projects", icon: FolderKanban },
];

/** Keep only the chips relevant to the active tab; All/Journal keep them as-is /
 * hide them. People/Projects keep just that kind. */
function chipsForFilter(
	chips: TimelineChip[],
	filter: TimelineFilter,
): TimelineChip[] {
	if (filter === "journal") return [];
	if (filter === "person") return chips.filter((c) => c.kind === "person");
	if (filter === "project") return chips.filter((c) => c.kind === "project");
	return chips;
}

/** Does this event survive the type tab? People/Projects hide entries that touch
 * no entity of that kind; All/Journal keep every entry. */
function eventMatchesFilter(
	chips: TimelineChip[],
	filter: TimelineFilter,
): boolean {
	if (filter === "person") return chips.some((c) => c.kind === "person");
	if (filter === "project") return chips.some((c) => c.kind === "project");
	return true;
}

export function TimelineView({
	filter,
	onFilterChange,
	focusEntityId,
	onFocusChange,
}: {
	filter: TimelineFilter;
	onFilterChange: (filter: TimelineFilter) => void;
	/** The entity whose lens is open in the focus rail; `null`/absent = no rail. */
	focusEntityId?: string | null;
	onFocusChange: (entityId: string | null) => void;
}) {
	const { data, isPending, isError } = useLibraryItems();
	const items = data ?? [];
	const allDays = buildTimeline(items);
	const days = allDays
		.map((day) => ({
			...day,
			events: day.events.filter((e) => eventMatchesFilter(e.chips, filter)),
		}))
		.filter((day) => day.events.length > 0);
	// Distinguish "no journal entries at all" from "the active People/Projects
	// filter hid every entry" — the same empty copy for both would lie ("nothing
	// here yet") when the timeline actually has entries, just none touching that
	// kind. `filter !== "all"` narrows the message to the filter.
	const filteredEmpty = days.length === 0 && allDays.length > 0;

	return (
		<div className="flex h-full min-h-0">
			<section
				aria-label="Timeline"
				className="flex h-full min-h-0 flex-1 flex-col"
			>
				{/* A visual row of filter toggle buttons (each self-labeled); not an ARIA
				    tablist — that contract needs roving focus + aria-controls we don't have. */}
				<div className="flex shrink-0 flex-wrap gap-1 px-6 pt-4 pb-3">
					{TABS.map((tab) => {
						const Icon = tab.icon;
						const active = tab.filter === filter;
						return (
							<button
								key={tab.filter}
								type="button"
								aria-pressed={active}
								onClick={() => onFilterChange(tab.filter)}
								className={cn(
									"inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-sm transition-colors",
									"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
									active
										? "bg-secondary text-foreground"
										: "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
								)}
							>
								<Icon className="size-4 shrink-0" aria-hidden />
								{tab.label}
							</button>
						);
					})}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
					<div className="mx-auto w-full max-w-3xl">
						{isPending ? null : isError ? (
							<EmptyState
								icon={History}
								tone="danger"
								title="Couldn't load timeline"
								description="Something went wrong reading your workspace. Try reloading."
							/>
						) : days.length === 0 ? (
							<EmptyState
								icon={History}
								title={
									filteredEmpty
										? "No entries match this filter"
										: "Nothing on the timeline yet"
								}
								description={
									filteredEmpty
										? "No Journal Entries touch a matching item. Switch to All to see the full timeline."
										: "Journal Entries show up here in time order, with the people and projects each one touches."
								}
							/>
						) : (
							<ol className="flex flex-col gap-6">
								{days.map((day) => (
									<li key={day.day}>
										<h2 className="sticky top-0 bg-background py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
											{formatDay(day.day)}
										</h2>
										<ul className="mt-1 flex flex-col gap-3">
											{day.events.map((event) => (
												<li
													key={event.entry.id}
													className="rounded-lg border border-border/60 px-4 py-3"
												>
													<p className="break-words text-pretty text-foreground text-sm leading-relaxed">
														{event.excerpt}
													</p>
													{(() => {
														const chips = chipsForFilter(event.chips, filter);
														return chips.length > 0 ? (
															<div className="mt-2 flex flex-wrap gap-1.5">
																{chips.map((chip) => (
																	// A chip opens that entity's focus lens (the rail), not a
																	// jump to its collection — the "same entity, different
																	// lens" proof (ADR-0054 §4). Focus selection lives in the
																	// route's `?focus=`, mirroring the `?id=` rail-open pattern.
																	<button
																		key={chip.entityId}
																		type="button"
																		onClick={() => onFocusChange(chip.entityId)}
																		aria-pressed={
																			chip.entityId === focusEntityId
																		}
																		className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 font-medium text-secondary-foreground text-xs transition-colors hover:bg-secondary/70 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-primary/20"
																	>
																		{chip.title}
																	</button>
																))}
															</div>
														) : null;
													})()}
												</li>
											))}
										</ul>
									</li>
								))}
							</ol>
						)}
					</div>
				</div>
			</section>

			{focusEntityId ? (
				<div className="w-80 shrink-0 border-border/60 border-l">
					<FocusedEntityRail
						key={focusEntityId}
						entityId={focusEntityId}
						items={items}
						onClose={() => onFocusChange(null)}
					/>
				</div>
			) : null}
		</div>
	);
}
