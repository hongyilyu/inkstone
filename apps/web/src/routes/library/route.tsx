import {
	createFileRoute,
	Outlet,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { EntityDetail } from "@/components/library/EntityDetail";
import { LibraryNav } from "@/components/library/LibraryNav";
import { EmptyState } from "@/components/ui/empty-state";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import { entityTitle, KIND_META, kindForSlug } from "@/lib/entities";
import { useEntities } from "@/lib/hooks/useEntities";

/**
 * Library shell (peer to Chat, reached from the sidebar). Composes the shared
 * `WorkspaceShell` (ADR-0021): the same framed middle as the chat surface, plus
 * the same collapsible right rail.
 *
 * Every Library surface — the Today overview (`/library`) and each collection
 * (`/library/$kind`) — mounts the rail, so the card's framed shape and bay are
 * constant everywhere. Selecting a row sets `?id` on the *current* route, so the
 * detail Inspector opens in place rather than switching views. The rail stays
 * collapsed until something is selected (then it opens); a manual toggle wins
 * until the selection changes. Dismissing is the rail's collapse control — the
 * inspector has no separate close button.
 */
function LibraryLayout() {
	const params = useParams({ strict: false });
	const search = useSearch({ strict: false });
	const { data } = useEntities();

	const slug = typeof params.kind === "string" ? params.kind : undefined;
	const id =
		"id" in search && typeof search.id === "string" ? search.id : undefined;
	// On a collection the selection is constrained to that kind; on Today there's
	// no kind, so resolve by id across every entity.
	const kind = slug ? kindForSlug(slug) : undefined;
	const selected = id
		? (data?.find((e) => e.id === id && (kind ? e.kind === kind : true)) ??
			null)
		: null;

	// Collapse follows selection (open on select, collapsed with none); a manual
	// toggle overrides until the selection changes, when it resets to follow again.
	const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the selection id.
	useEffect(() => {
		setManualCollapsed(null);
	}, [selected?.id]);

	// The rail is the pink chrome (`bg-sidebar`), matching the chat surface's
	// activity rail and the bay — not the white reading surface of the card.
	const rail = selected ? (
		<aside
			aria-label={`${entityTitle(selected)} details`}
			className="h-full bg-sidebar"
		>
			<EntityDetail
				key={selected.id}
				entity={selected}
				allEntities={data ?? []}
			/>
		</aside>
	) : (
		<aside
			aria-label="Details"
			className="grid h-full place-items-center bg-sidebar px-6"
		>
			<EmptyState
				icon={kind ? KIND_META[kind].icon : PanelRight}
				title="Nothing selected"
				description={
					kind
						? `Pick a ${KIND_META[kind].label.toLowerCase()} from the list to see its details here.`
						: "Pick an item from your library to see its details here."
				}
			/>
		</aside>
	);

	return (
		<WorkspaceShell
			nav={<LibraryNav />}
			rightRail={rail}
			rightRailWidth="400px"
			railLabel="details panel"
			collapsed={manualCollapsed ?? !selected}
			onCollapsedChange={setManualCollapsed}
		>
			<main className="relative h-full">
				<Outlet />
			</main>
		</WorkspaceShell>
	);
}

export const Route = createFileRoute("/library")({
	component: LibraryLayout,
});
