import {
	createFileRoute,
	Outlet,
	useNavigate,
	useParams,
	useSearch,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { EntityDetail } from "@/components/library/EntityDetail";
import { LibraryNav } from "@/components/library/LibraryNav";
import { TodoEditor } from "@/components/library/TodoEditor";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	KIND_META,
	libraryItemKindForSlug,
	libraryItemTitle,
} from "@/lib/libraryItems";

/** Library shell (ADR-0021): shared `WorkspaceShell` with a right rail that mounts only on selection — bay/rail/collapse behavior in docs/design/web-runtime.md. */
function LibraryLayout() {
	const params = useParams({ strict: false });
	const search = useSearch({ strict: false });
	const navigate = useNavigate();
	const { data } = useLibraryItems();

	const slug = typeof params.kind === "string" ? params.kind : undefined;
	const id =
		"id" in search && typeof search.id === "string" ? search.id : undefined;
	const creating = "new" in search && search.new === true;
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the selection id / create intent.
	useEffect(() => {
		setManualCollapsed(null);
	}, [selected?.id, creating]);

	// `?new=1` (Todo only this slice) closes the editor back to the bare collection.
	const closeCreate = () =>
		slug &&
		navigate({ to: "/library/$kind", params: { kind: slug }, search: {} });
	const openCreated = (newId: string) =>
		slug &&
		navigate({
			to: "/library/$kind",
			params: { kind: slug },
			search: { id: newId },
		});

	// Rail mounts on a create intent or a selection (else `null` → plain framed card) — see docs/design/web-runtime.md.
	const rail =
		creating && kind === "todo" ? (
			<aside
				aria-label={`New ${KIND_META.todo.label}`}
				className="h-full bg-sidebar"
			>
				<TodoEditor
					mode="create"
					allEntities={data ?? []}
					onDone={openCreated}
					onCancel={closeCreate}
				/>
			</aside>
		) : selected ? (
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
