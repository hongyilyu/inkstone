// Throwaway stopgap (#232): a flat list of future-deferred Todos. Superseded by the shared Forecast/calendar view (#236).
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CalendarArrowUp } from "lucide-react";
import { DerivedTodoView } from "@/components/library/DerivedTodoView";
import { scheduledTodos } from "@/lib/libraryItems";

interface ScheduledSearch {
	id?: string;
}

function ScheduledRoute() {
	const { id } = Route.useSearch();
	const navigate = useNavigate();

	return (
		<DerivedTodoView
			title="Scheduled"
			intro="Active todos you've deferred to a future date — they become available on the date shown."
			icon={CalendarArrowUp}
			select={scheduledTodos}
			emptyTitle="Nothing scheduled"
			emptyDescription="Todos you defer to a future date show up here until they become available."
			selectedId={id ?? null}
			onSelect={(next) =>
				navigate({ to: "/library/scheduled", search: { id: next } })
			}
		/>
	);
}

export const Route = createFileRoute("/library/scheduled")({
	validateSearch: (search: Record<string, unknown>): ScheduledSearch => ({
		id: typeof search.id === "string" ? search.id : undefined,
	}),
	component: ScheduledRoute,
});
