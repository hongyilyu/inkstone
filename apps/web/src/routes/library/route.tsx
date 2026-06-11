import {
	createFileRoute,
	Outlet,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { EntityDetail } from "@/components/library/EntityDetail";
import { LibraryNav } from "@/components/library/LibraryNav";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import { libraryItemKindForSlug, libraryItemTitle } from "@/lib/libraryItems";

/**
 * Library shell (peer to Chat, reached from the sidebar). Composes the shared
 * `WorkspaceShell` (ADR-0021): the same framed middle as the chat surface, plus
 * the same collapsible right rail.
 *
 * The rail mounts only when a row is selected. Selecting a row sets `?id` on the
 * *current* route, so the detail Inspector opens in place rather than switching
 * views — and only then does the card carry the carved bay and its collapse
 * toggle. With nothing selected the shell renders a plain framed card (no bay,
 * no toggle), so the bay/toggle always signal "there is content here". On
 * selection the rail opens; the collapse toggle then hides it to a sliver while
 * keeping the selection (the bay stays), and a manual toggle wins until the
 * selection changes. The bay disappears again once nothing is selected (e.g.
 * navigating to another collection).
 */
function LibraryLayout() {
	const params = useParams({ strict: false });
	const search = useSearch({ strict: false });
	const { data } = useLibraryItems();

	const slug = typeof params.kind === "string" ? params.kind : undefined;
	const id =
		"id" in search && typeof search.id === "string" ? search.id : undefined;
	// On a collection the selection is constrained to that kind; on Today there's
	// no kind, so resolve by id across every item.
	const kind = slug ? libraryItemKindForSlug(slug) : undefined;
	const selected = id
		? (data?.find((e) => e.id === id && (kind ? e.kind === kind : true)) ??
			null)
		: null;

	// Default to open when a row is selected; a manual collapse overrides until
	// the selection changes, when it resets to open again.
	const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the selection id.
	useEffect(() => {
		setManualCollapsed(null);
	}, [selected?.id]);

	// The rail mounts only when a row is selected — that's when there's real
	// content, and so when the card carries the carved bay + collapse toggle.
	// With nothing selected we pass `null`, and the shell renders a plain framed
	// card. The rail is the pink chrome (`bg-sidebar`), matching the chat
	// surface's activity rail and the bay — not the white reading surface.
	const rail = selected ? (
		<aside
			aria-label={`${libraryItemTitle(selected)} details`}
			className="h-full bg-sidebar"
		>
			<EntityDetail
				key={selected.id}
				entity={selected}
				allEntities={data ?? []}
			/>
		</aside>
	) : null;

	return (
		<WorkspaceShell
			nav={<LibraryNav />}
			rightRail={rail}
			rightRailWidth="400px"
			railLabel="details panel"
			collapsed={manualCollapsed ?? false}
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
