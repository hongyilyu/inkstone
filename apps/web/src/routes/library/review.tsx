import { createFileRoute, redirect } from "@tanstack/react-router";

// Retired flat-era workflow route (ADR-0054): the Review view is now a GTD filter.
// The redirect forwards any incoming `?id=` (a deep-linked/bookmarked selection) so
// the selected entity's detail rail still opens on the GTD surface.
interface RetiredSearch {
	id?: string;
}

export const Route = createFileRoute("/library/review")({
	validateSearch: (search: Record<string, unknown>): RetiredSearch => ({
		id: typeof search.id === "string" && search.id ? search.id : undefined,
	}),
	beforeLoad: ({ search }) => {
		throw redirect({
			to: "/library/gtd",
			search: { filt: "review", id: search.id },
		});
	},
});
