import type { JsonObject } from "@inkstone/protocol";
import { createFileRoute } from "@tanstack/react-router";
import { TodayOverview } from "@/components/library/TodayOverview";
import { asString } from "@/lib/readPayload";

interface TodaySearch {
	id?: string;
}

export const Route = createFileRoute("/library/")({
	// Today can select an entity in place (the shell rail shows its detail without
	// leaving the overview), so it carries the same `?id` as a collection.
	validateSearch: (search: JsonObject): TodaySearch => ({
		id: asString(search.id),
	}),
	component: TodayOverview,
});
