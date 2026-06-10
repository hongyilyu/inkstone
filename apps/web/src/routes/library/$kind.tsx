import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { EntityCollection } from "@/components/library/EntityCollection";
import { Button } from "@/components/ui/button.js";
import { EmptyState } from "@/components/ui/empty-state";
import { kindForSlug } from "@/lib/entities";

interface KindSearch {
	id?: string;
}

function KindRoute() {
	const { kind: slug } = Route.useParams();
	const { id } = Route.useSearch();
	const navigate = useNavigate();
	const kind = kindForSlug(slug);

	if (!kind) {
		return (
			<div className="grid h-full place-items-center px-6">
				<EmptyState
					icon={Search}
					title="Unknown collection"
					description="That collection doesn't exist. Head back to your library."
					action={
						<Button
							variant="chip"
							size="pill"
							onClick={() => navigate({ to: "/library" })}
						>
							Back to Today
						</Button>
					}
				/>
			</div>
		);
	}

	return (
		<EntityCollection
			kind={kind}
			selectedId={id ?? null}
			onSelect={(next) =>
				navigate({
					to: "/library/$kind",
					params: { kind: slug },
					search: { id: next },
				})
			}
		/>
	);
}

export const Route = createFileRoute("/library/$kind")({
	validateSearch: (search: Record<string, unknown>): KindSearch => ({
		id: typeof search.id === "string" ? search.id : undefined,
	}),
	component: KindRoute,
});
