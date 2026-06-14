import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { EntityCollection } from "@/components/library/EntityCollection";
import { Button } from "@/components/ui/button.js";
import { EmptyState } from "@/components/ui/empty-state";
import { libraryItemKindForSlug } from "@/lib/libraryItems";

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
			// Todo, Person, Project, Journal Entry, and Bookmark are manually-creatable in the rail (ADR-0033).
			onNew={
				kind === "todo" ||
				kind === "person" ||
				kind === "project" ||
				kind === "journal_entry" ||
				kind === "bookmark"
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
