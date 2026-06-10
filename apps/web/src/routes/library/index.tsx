import { createFileRoute } from "@tanstack/react-router";
import { TodayOverview } from "@/components/library/TodayOverview";

interface TodaySearch {
	id?: string;
}

export const Route = createFileRoute("/library/")({
	// Today can select an entity in place (the shell rail shows its detail without
	// leaving the overview), so it carries the same `?id` as a collection.
	validateSearch: (search: Record<string, unknown>): TodaySearch => ({
		id: typeof search.id === "string" ? search.id : undefined,
	}),
	component: TodayOverview,
});
