import {
	createFileRoute,
	Outlet,
	useNavigate,
	useParams,
	useRouterState,
	useSearch,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { EntityDetail } from "@/components/library/EntityDetail";
import { JournalEntryEditor } from "@/components/library/JournalEntryEditor";
import { MediaEditor } from "@/components/library/MediaEditor";
import { PersonEditor } from "@/components/library/PersonEditor";
import { ProjectEditor } from "@/components/library/ProjectEditor";
import { TodoEditor } from "@/components/library/TodoEditor";
import { TopicNav } from "@/components/library/TopicNav";
import { WorkspaceShell } from "@/components/ui/workspace-shell";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	CREATABLE_KINDS,
	KIND_META,
	type LibraryItem,
	type LibraryItemKind,
	libraryItemKindForSlug,
	libraryItemTitle,
} from "@/lib/libraryItems";

/** The default rail width; the Journal body editor wants more room (ADR-0033). */
const RAIL_WIDTH_DEFAULT = "400px";
const RAIL_WIDTH_JOURNAL = "520px";

/** Library shell (ADR-0021): shared `WorkspaceShell` with a right rail that mounts only on selection — bay/rail/collapse behavior in docs/design/web-runtime.md. */
function LibraryLayout() {
	const params = useParams({ strict: false });
	const search = useSearch({ strict: false });
	const navigate = useNavigate();
	const { data } = useLibraryItems();

	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const slug = typeof params.kind === "string" ? params.kind : undefined;
	const id =
		"id" in search && typeof search.id === "string" ? search.id : undefined;
	const creating = "new" in search && search.new === true;
	// The Media topic is a STATIC route (`/library/media`), not `$kind`, so it
	// carries no `params.kind`. Its slug ("media") collides with the `$kind` route,
	// so the collection lives behind the static route and selection/create ride the
	// search on it (ADR-0059). Resolve the kind from the slug, else from the media
	// pathname, so the rail can mount the Media create editor + detail there.
	const onMediaRoute = pathname === "/library/media";
	// On a collection the selection is constrained to that kind; on Today there's
	// no kind, so resolve by id across every item.
	const kind = slug
		? libraryItemKindForSlug(slug)
		: onMediaRoute
			? ("media" as const)
			: undefined;
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

	// `?new=1` closes the editor back to the bare collection. On the static Media
	// route there's no `$kind` slug, so route in-place (`to: "."`) — the create
	// flow's search rides the current `/library/media` path (ADR-0059).
	const closeCreate = () => {
		if (slug) {
			navigate({ to: "/library/$kind", params: { kind: slug }, search: {} });
		} else if (onMediaRoute) {
			navigate({ to: ".", search: {} });
		}
	};
	const openCreated = (newId: string) => {
		if (slug) {
			navigate({
				to: "/library/$kind",
				params: { kind: slug },
				search: { id: newId },
			});
		} else if (onMediaRoute) {
			navigate({ to: ".", search: { id: newId } });
		}
	};

	// The Journal Entry editor (create or edit) needs a wider rail for its body
	// editor; everything else uses the default width.
	const railWidth =
		(creating && kind === "journal_entry") || selected?.kind === "journal_entry"
			? RAIL_WIDTH_JOURNAL
			: RAIL_WIDTH_DEFAULT;

	// Rail mounts on a create intent or a selection (else `null` → plain framed card) — see docs/design/web-runtime.md.
	const rail =
		creating && kind && CREATABLE_KINDS.has(kind) ? (
			<aside
				aria-label={`New ${KIND_META[kind].label}`}
				className="h-full bg-sidebar"
			>
				<CreateEditor
					kind={kind}
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
			nav={<TopicNav />}
			rightRail={rail}
			rightRailWidth={railWidth}
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

/** The blank create editor for a creatable kind, mounted in the rail on `?new=1`. */
function CreateEditor({
	kind,
	allEntities,
	onDone,
	onCancel,
}: {
	kind: LibraryItemKind;
	allEntities: LibraryItem[];
	onDone: (id: string) => void;
	onCancel: () => void;
}) {
	if (kind === "person") {
		return <PersonEditor mode="create" onDone={onDone} onCancel={onCancel} />;
	}
	if (kind === "project") {
		return <ProjectEditor mode="create" onDone={onDone} onCancel={onCancel} />;
	}
	if (kind === "journal_entry") {
		return (
			<JournalEntryEditor mode="create" onDone={onDone} onCancel={onCancel} />
		);
	}
	if (kind === "media") {
		return <MediaEditor mode="create" onDone={onDone} onCancel={onCancel} />;
	}
	return (
		<TodoEditor
			mode="create"
			allEntities={allEntities}
			onDone={onDone}
			onCancel={onCancel}
		/>
	);
}

export const Route = createFileRoute("/library")({
	component: LibraryLayout,
});
