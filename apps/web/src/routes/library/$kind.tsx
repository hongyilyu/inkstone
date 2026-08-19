import type { JsonObject } from "@inkstone/protocol";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { EntityCollection } from "@/components/library/EntityCollection";
import { ProjectReviewView } from "@/components/library/ProjectReviewView";
import { Button } from "@/components/ui/button.js";
import { EmptyState } from "@/components/ui/empty-state";
import { CREATABLE_KINDS, libraryItemKindForSlug } from "@/lib/libraryItems";
import { asString } from "@/lib/readPayload";

interface KindSearch {
	id?: string;
	/** When true, the rail shows a blank editor to create a new item (ADR-0033). */
	new?: boolean;
	/** When true on the Project surface, the body is the Project Review queue
	 * (ADR-0034; relocated here from the retired GTD topic). */
	review?: boolean;
}

function KindRoute() {
	const { kind: slug } = Route.useParams();
	const { id, review } = Route.useSearch();
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

	// Project Review lives on the Project surface (ADR-0034): `?review` swaps the
	// collection body for the focused review queue.
	if (kind === "project" && review) return <ProjectReviewView />;

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
			onReview={
				kind === "project"
					? () =>
							navigate({
								to: "/library/$kind",
								params: { kind: slug },
								search: { review: true },
							})
					: undefined
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
	validateSearch: (search: JsonObject): KindSearch => ({
		id: asString(search.id),
		new: search.new === true || search.new === "true" ? true : undefined,
		review:
			search.review === true || search.review === "true" ? true : undefined,
	}),
	component: KindRoute,
});
