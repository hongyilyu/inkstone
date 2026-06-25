import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { EntityCollection } from "@/components/library/EntityCollection";
import { Button } from "@/components/ui/button.js";
import { EmptyState } from "@/components/ui/empty-state";
import { CREATABLE_KINDS, libraryItemKindForSlug } from "@/lib/libraryItems";

interface KindSearch {
	id?: string;
	/** When true, the rail shows a blank editor to create a new item (ADR-0033). */
	new?: boolean;
}

function KindRoute() {
	const { kind: slug } = Route.useParams();
	const { id } = Route.useSearch();
	const navigate = useNavigate();
	const kind = libraryItemKindForSlug(slug);

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
		// key={kind} remounts on collection change so the ephemeral search query and
		// facet selection reset to empty — a People filter must not leak onto Projects.
		<EntityCollection
			key={kind}
			kind={kind}
			selectedId={id ?? null}
			onSelect={(next) =>
				navigate({
					to: "/library/$kind",
					params: { kind: slug },
					search: { id: next },
				})
			}
			// Manually-creatable kinds gate on the shared CREATABLE_KINDS set (ADR-0033).
			onNew={
				CREATABLE_KINDS.has(kind)
					? () =>
							navigate({
								to: "/library/$kind",
								params: { kind: slug },
								search: { new: true },
							})
					: undefined
			}
		/>
	);
}

export const Route = createFileRoute("/library/$kind")({
	validateSearch: (search: Record<string, unknown>): KindSearch => ({
		id: typeof search.id === "string" ? search.id : undefined,
		new: search.new === true || search.new === "true" ? true : undefined,
	}),
	component: KindRoute,
});
