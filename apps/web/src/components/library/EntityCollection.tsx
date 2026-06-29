import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	type ActiveFacets,
	composeFacets,
	deriveFacets,
	EMPTY_FACETS,
	type FacetKey,
	facetCounts,
	hasActiveFacets,
	toggleFacet,
} from "@/lib/libraryFacets";
import {
	groupJournalEntriesByDay,
	type JournalEntry,
	KIND_META,
	type LibraryItem,
	type LibraryItemKind,
	libraryItemTitle,
	type Project,
	searchLibraryItems,
	type Todo,
} from "@/lib/libraryItems";
import { EntityRow, TodoRow } from "./EntityRow.js";
import { EntitySkeleton } from "./EntitySkeleton.js";
import { FacetRow } from "./FacetRow.js";

const PROJECT_STATUS_RANK: Record<Project["status"], number> = {
	active: 0,
	on_hold: 1,
	completed: 2,
	dropped: 3,
};

function compareForKind(
	kind: LibraryItemKind,
): (a: LibraryItem, b: LibraryItem) => number {
	switch (kind) {
		case "journal_entry":
			return (a, b) =>
				(b as JournalEntry).occurredAt.localeCompare(
					(a as JournalEntry).occurredAt,
				) || a.id.localeCompare(b.id);
		case "person":
			return (a, b) => libraryItemTitle(a).localeCompare(libraryItemTitle(b));
		case "project":
			return (a, b) =>
				PROJECT_STATUS_RANK[(a as Project).status] -
					PROJECT_STATUS_RANK[(b as Project).status] || b.recency - a.recency;
		case "todo":
			return (a, b) => {
				const ta = a as Todo;
				const tb = b as Todo;
				// Active todos first, then by soonest due date, then most recent.
				const aActive = ta.status === "active";
				const bActive = tb.status === "active";
				if (aActive !== bActive) return aActive ? -1 : 1;
				const da = ta.dueAt ?? "￿";
				const db = tb.dueAt ?? "￿";
				return da.localeCompare(db) || b.recency - a.recency;
			};
		case "media":
			return (a, b) => b.recency - a.recency;
	}
}

/** Searchable list for one Library item kind; selecting a row reports its id (the route sets `?id`, Inspector renders in the shared rail). `onNew`, when given, surfaces a header action that opens a blank editor in the rail (ADR-0033). */
export function EntityCollection({
	kind,
	selectedId,
	onSelect,
	onNew,
}: {
	kind: LibraryItemKind;
	selectedId: string | null;
	onSelect: (id: string) => void;
	onNew?: () => void;
}) {
	const { data, isPending, isError } = useLibraryItems();
	const [query, setQuery] = useState("");
	const [facets, setFacets] = useState<ActiveFacets>(EMPTY_FACETS);
	const meta = KIND_META[kind];

	// `query` and `facets` are ephemeral and collection-scoped. The route mounts
	// this with `key={kind}`, so switching collections remounts the component and
	// resets both to empty — a People filter can't leak onto Projects.

	const allItems = useMemo(() => data ?? [], [data]);

	const ofKind = useMemo(
		() => allItems.filter((e) => e.kind === kind),
		[allItems, kind],
	);

	// The text-search (or kind-sorted) base, BEFORE facets narrow it.
	const base = useMemo(() => {
		if (query.trim()) return searchLibraryItems(ofKind, query);
		return [...ofKind].sort(compareForKind(kind));
	}, [ofKind, kind, query]);

	// Facet groups derived from the UNFILTERED kind set (so groups don't flicker as
	// the user toggles); only individual chips dim/hide via leave-one-out counts.
	const facetGroups = useMemo(
		() => deriveFacets(kind, ofKind, allItems),
		[kind, ofKind, allItems],
	);

	// Leave-one-out counts per group, computed over the query-narrowed base. Only
	// keys for the present groups are populated, so the type is Partial (FacetRow
	// reads counts for the same groups it renders, falling back to an empty Map).
	const counts = useMemo(() => {
		const out: Partial<Record<FacetKey, Map<string, number>>> = {};
		for (const group of facetGroups) {
			out[group.key] = facetCounts(group.key, base, facets, allItems);
		}
		return out;
	}, [facetGroups, base, facets, allItems]);

	const items = useMemo(
		() => composeFacets(base, facets, allItems),
		[base, facets, allItems],
	);

	const filtersActive = query.trim().length > 0 || hasActiveFacets(facets);
	const resetAll = () => {
		setQuery("");
		setFacets(EMPTY_FACETS);
	};

	// Show the load-failure state ONLY when the read errored AND we have no cached
	// rows of this kind to fall back on. A refetch error with a coherent cache keeps
	// the stale-but-usable list (count + New stay live against it).
	const showError = isError && ofKind.length === 0;

	return (
		<section aria-label={meta.plural} className="flex h-full min-h-0 flex-col">
			<header className="shrink-0 px-6 pt-6 pb-4">
				<div className="mx-auto w-full max-w-3xl">
					<div className="flex items-baseline gap-2">
						<h1 className="font-bold text-2xl text-foreground tracking-tight">
							{meta.plural}
						</h1>
						{/* Hide the count on a failed read — a "0" beside the body's
						    "Couldn't load…" would contradict it (the read FAILED, the
						    collection isn't empty). */}
						{showError ? null : (
							<span className="text-muted-foreground text-sm">
								{ofKind.length}
							</span>
						)}
						{/* Suppress New while the read failed: the create editor's relation
						    pickers source from this same (failed) list, so opening it offline
						    would show empty People/Project options as if none exist. */}
						{onNew && !showError ? (
							<Button
								variant="chip"
								size="pill"
								className="ml-auto"
								onClick={onNew}
							>
								<Plus className="size-4" aria-hidden />
								New {meta.label}
							</Button>
						) : null}
					</div>
					<SearchField
						variant="box"
						wrapperClassName="mt-4"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onClear={() => setQuery("")}
						aria-label={`Search ${meta.plural.toLowerCase()}`}
						placeholder={`Search ${meta.plural.toLowerCase()}…`}
					/>
					{/* Facet controls compose over the same in-memory set as the search.
					    Hidden while loading/errored/first-run — there's nothing to filter. */}
					{!isPending && !showError && ofKind.length > 0 ? (
						<FacetRow
							groups={facetGroups}
							active={facets}
							counts={counts}
							onToggle={(key, value) =>
								setFacets((prev) => toggleFacet(prev, key, value))
							}
							onClear={() => setFacets(EMPTY_FACETS)}
						/>
					) : null}
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
				<div className="mx-auto w-full max-w-3xl">
					{isPending ? (
						<EntitySkeleton rows={8} />
					) : showError ? (
						// Error with NO cached rows of this kind → an honest load failure.
						// If a later refetch fails but TanStack still has a coherent cached
						// snapshot, fall through and render the stale-but-usable rows rather
						// than blanking the collection on a transient outage.
						<EmptyState
							icon={meta.icon}
							tone="danger"
							title={`Couldn't load ${meta.plural.toLowerCase()}`}
							description="Something went wrong reading your workspace. Try reloading."
						/>
					) : ofKind.length === 0 ? (
						<EmptyState
							icon={meta.icon}
							title={`No ${meta.plural.toLowerCase()} yet`}
							description={
								onNew
									? `Use New ${meta.label} to add one, or accept a proposal suggested from chats.`
									: `${meta.plural} appear here as Inkstone notices them in your chats and you accept the Proposal.`
							}
						/>
					) : items.length === 0 ? (
						// Search and/or facets narrowed everything out. One honest "no
						// matches" state with a single Reset that clears BOTH the facets and
						// the query (the inline facet "Clear" and the SearchField ✕ stay for
						// partial resets).
						<EmptyState
							icon={Search}
							title={`No ${meta.plural.toLowerCase()} match your filters`}
							description="Try removing a filter or search term."
							action={
								filtersActive ? (
									<Button variant="chip" size="pill" onClick={resetAll}>
										Reset
									</Button>
								) : undefined
							}
						/>
					) : kind === "journal_entry" ? (
						<JournalEntryGroups
							entries={items.filter(
								(item): item is JournalEntry => item.kind === "journal_entry",
							)}
							selectedId={selectedId}
							onSelect={onSelect}
						/>
					) : (
						<ul className="flex flex-col gap-0.5">
							{items.map((item) =>
								item.kind === "todo" ? (
									<TodoRow
										key={item.id}
										todo={item}
										allItems={data ?? []}
										selected={item.id === selectedId}
										onSelect={onSelect}
										onComplete={() => {}}
										onQuickDefer={() => {}}
									/>
								) : (
									<li key={item.id}>
										<EntityRow
											entity={item}
											selected={item.id === selectedId}
											onSelect={onSelect}
										/>
									</li>
								),
							)}
						</ul>
					)}
				</div>
			</div>
		</section>
	);
}

function JournalEntryGroups({
	entries,
	selectedId,
	onSelect,
}: {
	entries: JournalEntry[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	return (
		<div className="flex flex-col gap-6">
			{groupJournalEntriesByDay(entries).map((day) => {
				const headingId = `journal-day-${day.day}`;
				return (
					<section
						key={day.day}
						aria-labelledby={headingId}
						className="flex flex-col gap-2"
					>
						<div className="flex items-baseline gap-2 border-border border-b pb-2">
							<h2
								id={headingId}
								className="font-semibold text-foreground text-sm"
							>
								{day.day}
							</h2>
							<span className="text-muted-foreground text-xs">
								{day.entries.length}
							</span>
						</div>
						<ul className="flex flex-col gap-0.5">
							{day.entries.map((entry) => (
								<li key={entry.id}>
									<EntityRow
										entity={entry}
										selected={entry.id === selectedId}
										onSelect={onSelect}
									/>
								</li>
							))}
						</ul>
					</section>
				);
			})}
		</div>
	);
}
