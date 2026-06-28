import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	type HealthFilter,
	HealthView,
	KNOWN_SCHEMAS,
} from "@/components/library/HealthView";

interface HealthSearch {
	/** The active schema filter. Omitted from the URL = All (the default). */
	schema?: NonNullable<HealthFilter>;
}

function HealthRoute() {
	const { schema } = Route.useSearch();
	const navigate = useNavigate();

	return (
		<HealthView
			filter={schema}
			onFilterChange={(next) =>
				// Default (All) is omitted from the URL; keep any other search params.
				navigate({
					to: "/library/health",
					search: (prev) => ({ ...prev, schema: next }),
				})
			}
		/>
	);
}

export const Route = createFileRoute("/library/health")({
	validateSearch: (search: Record<string, unknown>): HealthSearch => ({
		// Tolerate an absent or garbage `?schema=` → undefined (= All).
		schema: KNOWN_SCHEMAS.includes(search.schema as NonNullable<HealthFilter>)
			? (search.schema as NonNullable<HealthFilter>)
			: undefined,
	}),
	component: HealthRoute,
});
