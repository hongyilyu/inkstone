import { createFileRoute } from "@tanstack/react-router";
import { TodayOverview } from "@/components/library/TodayOverview";

export const Route = createFileRoute("/library/")({
	component: TodayOverview,
});
