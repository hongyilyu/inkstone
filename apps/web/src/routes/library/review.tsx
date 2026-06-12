import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ProjectReviewView } from "@/components/library/ProjectReviewView";

interface ReviewSearch {
	id?: string;
}

function ReviewRoute() {
	const { id } = Route.useSearch();
	const navigate = useNavigate();

	return (
		<ProjectReviewView
			selectedId={id ?? null}
			onSelect={(next) =>
				navigate({ to: "/library/review", search: { id: next } })
			}
		/>
	);
}

export const Route = createFileRoute("/library/review")({
	validateSearch: (search: Record<string, unknown>): ReviewSearch => ({
		id: typeof search.id === "string" ? search.id : undefined,
	}),
	component: ReviewRoute,
});
