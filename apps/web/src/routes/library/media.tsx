import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EntityCollection } from "@/components/library/EntityCollection";

interface MediaSearch {
	/** Selected Media item → the shared rail renders its detail. */
	id?: string;
	/** When true, the rail shows a blank editor to create a new Media item (ADR-0033). */
	new?: boolean;
}

/**
 * The Media topic (ADR-0059): the live faceted `EntityCollection` for the `media`
 * kind. Unlike the other collections it lives behind a STATIC route, because the
 * `media` slug collides with `$kind` — so selection (`?id`) and create (`?new`)
 * ride this route in-place (the shared rail in `route.tsx` reads them), rather than
 * navigating to `/library/$kind`.
 */
function MediaRoute() {
	const { id } = Route.useSearch();
	const navigate = useNavigate();

	// `?new` is read by the shared rail in route.tsx, which mounts the create editor;
	// here we only need the collection's selection + New affordance.
	return (
		<EntityCollection
			kind="media"
			selectedId={id ?? null}
			onSelect={(next) => navigate({ to: ".", search: { id: next } })}
			onNew={() => navigate({ to: ".", search: { new: true } })}
		/>
	);
}

export const Route = createFileRoute("/library/media")({
	validateSearch: (search: Record<string, unknown>): MediaSearch => ({
		id: typeof search.id === "string" && search.id ? search.id : undefined,
		new: search.new === true || search.new === "true" ? true : undefined,
	}),
	component: MediaRoute,
});
