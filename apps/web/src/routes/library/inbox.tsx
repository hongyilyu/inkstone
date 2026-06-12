import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { DerivedTodoView } from "@/components/library/DerivedTodoView";
import { inboxTodos } from "@/lib/libraryItems";

interface InboxSearch {
	id?: string;
}

function InboxRoute() {
	const { id } = Route.useSearch();
	const navigate = useNavigate();

	return (
		<DerivedTodoView
			title="Inbox"
			intro="Active todos you haven't organized yet — no project, no due date, no people."
			icon={Inbox}
			select={inboxTodos}
			emptyTitle="Inbox zero"
			emptyDescription="Nothing unsorted. New todos land here until you give them a project, a due date, or a person."
			selectedId={id ?? null}
			onSelect={(next) =>
				navigate({ to: "/library/inbox", search: { id: next } })
			}
		/>
	);
}

export const Route = createFileRoute("/library/inbox")({
	validateSearch: (search: Record<string, unknown>): InboxSearch => ({
		id: typeof search.id === "string" ? search.id : undefined,
	}),
	component: InboxRoute,
});
