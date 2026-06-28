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
}

function TimelineRoute() {
	const { filter } = Route.useSearch();
	const navigate = useNavigate();

	return (
		<TimelineView
			filter={filter ?? "all"}
			onFilterChange={(next) =>
				// Default filter omitted from the URL; keep the tab through a swap.
				navigate({
					to: "/library/timeline",
					search: { filter: next === "all" ? undefined : next },
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
	}),
	component: TimelineRoute,
});
