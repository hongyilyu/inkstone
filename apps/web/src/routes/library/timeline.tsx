import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	type TimelineFilter,
	TimelineView,
} from "@/components/library/TimelineView";

const TIMELINE_FILTERS: TimelineFilter[] = [
	"all",
	"journal",
	"person",
	"project",
];

interface TimelineSearch {
	/** The active type tab. Omitted from the URL = "all" (the default). */
	filter?: TimelineFilter;
	/** The entity whose focus lens (the right rail) is open. Mirrors `?id=` on the
	 * shared layout rail, but kept distinct so it never perturbs the EntityDetail
	 * rail Today/`$kind` use (ADR-0054 §4). Absent = no rail. */
	focus?: string;
}

function TimelineRoute() {
	const { filter, focus } = Route.useSearch();
	const navigate = useNavigate();

	return (
		<TimelineView
			filter={filter ?? "all"}
			onFilterChange={(next) =>
				// Default filter omitted from the URL; keep the tab + focus through a swap.
				navigate({
					to: "/library/timeline",
					search: (prev) => ({
						...prev,
						filter: next === "all" ? undefined : next,
					}),
				})
			}
			focusEntityId={focus ?? null}
			onFocusChange={(entityId) =>
				navigate({
					to: "/library/timeline",
					search: (prev) => ({ ...prev, focus: entityId ?? undefined }),
				})
			}
		/>
	);
}

export const Route = createFileRoute("/library/timeline")({
	validateSearch: (search: Record<string, unknown>): TimelineSearch => ({
		filter: TIMELINE_FILTERS.includes(search.filter as TimelineFilter)
			? (search.filter as TimelineFilter)
			: undefined,
		focus: typeof search.focus === "string" ? search.focus : undefined,
	}),
	component: TimelineRoute,
});
