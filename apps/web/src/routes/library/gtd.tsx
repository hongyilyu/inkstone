import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type GtdFilter, GtdView } from "@/components/library/GtdView";

const GTD_FILTERS: GtdFilter[] = [
	"today",
	"inbox",
	"waiting",
	"scheduled",
	"review",
	"projects",
	"all",
];

interface GtdSearch {
	/** The active filter pill. Omitted from the URL = "today" (the default). */
	filt?: GtdFilter;
	/** Selected entity (todo/project) → the shared rail renders its detail. */
	id?: string;
}

function GtdRoute() {
	const { filt, id } = Route.useSearch();
	const navigate = useNavigate();

	return (
		<GtdView
			filt={filt ?? "today"}
			onFilterChange={(next) =>
				// Default filter omitted from the URL; keep the selection through a swap.
				navigate({
					to: "/library/gtd",
					search: { filt: next === "today" ? undefined : next, id },
				})
			}
			selectedId={id ?? null}
			onSelect={(next) =>
				navigate({ to: "/library/gtd", search: { filt, id: next } })
			}
		/>
	);
}

export const Route = createFileRoute("/library/gtd")({
	validateSearch: (search: Record<string, unknown>): GtdSearch => ({
		filt: GTD_FILTERS.includes(search.filt as GtdFilter)
			? (search.filt as GtdFilter)
			: undefined,
		// An empty `?id=` is "no selection", not a selection of "" — match the
		// retired-route redirects, which already strip empty ids before forwarding.
		id: typeof search.id === "string" && search.id ? search.id : undefined,
	}),
	component: GtdRoute,
});
