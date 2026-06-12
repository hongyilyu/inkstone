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

/** Library shell (ADR-0021): shared `WorkspaceShell` with a right rail that mounts only on selection — bay/rail/collapse behavior in docs/design/web-runtime.md. */
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

	// Rail mounts only on selection (else `null` → plain framed card) — see docs/design/web-runtime.md.
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
