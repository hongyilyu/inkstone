import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Hourglass } from "lucide-react";
import { DerivedTodoView } from "@/components/library/DerivedTodoView";
import { waitingTodos } from "@/lib/libraryItems";

interface WaitingSearch {
	id?: string;
}

function WaitingRoute() {
	const { id } = Route.useSearch();
	const navigate = useNavigate();

	return (
		<DerivedTodoView
			title="Waiting"
			intro="Active todos where you're waiting on someone — anything with a waiting-on person."
			icon={Hourglass}
			select={waitingTodos}
			emptyTitle="Nothing pending"
			emptyDescription="When you mark a todo as waiting on someone, it shows up here so you can follow up."
			selectedId={id ?? null}
			onSelect={(next) =>
				navigate({ to: "/library/waiting", search: { id: next } })
			}
		/>
	);
}

export const Route = createFileRoute("/library/waiting")({
	validateSearch: (search: Record<string, unknown>): WaitingSearch => ({
		id: typeof search.id === "string" ? search.id : undefined,
	}),
	component: WaitingRoute,
});
