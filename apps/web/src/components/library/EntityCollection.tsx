import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	groupJournalEntriesByDay,
	KIND_META,
	type JournalEntry,
	type LibraryItem,
	type LibraryItemKind,
	libraryItemTitle,
	type Project,
	searchLibraryItems,
	type Todo,
} from "@/lib/libraryItems";
import { EntityRow, TodoRow } from "./EntityRow.js";
import { EntitySkeleton } from "./EntitySkeleton.js";

const PROJECT_STATUS_RANK: Record<Project["status"], number> = {
	active: 0,
	review: 1,
	paused: 2,
	done: 3,
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
				if (ta.done !== tb.done) return ta.done ? 1 : -1;
				const da = ta.dueInDays ?? Number.POSITIVE_INFINITY;
				const db = tb.dueInDays ?? Number.POSITIVE_INFINITY;
				return da - db || b.recency - a.recency;
			};
		case "recipe":
			return (a, b) => b.recency - a.recency;
	}
}

/** Searchable list for one Library item kind; selecting a row reports its id (the route sets `?id`, Inspector renders in the shared rail). */
export function EntityCollection({
	kind,
	selectedId,
	onSelect,
}: {
	kind: LibraryItemKind;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const { data, isPending, isError } = useLibraryItems();
	const [query, setQuery] = useState("");
	const meta = KIND_META[kind];

	const ofKind = useMemo(
		() => (data ?? []).filter((e) => e.kind === kind),
		[data, kind],
	);

	const items = useMemo(() => {
		if (query.trim()) return searchLibraryItems(ofKind, query);
		return [...ofKind].sort(compareForKind(kind));
	}, [ofKind, kind, query]);

	return (
		<section aria-label={meta.plural} className="flex h-full min-h-0 flex-col">
			<header className="shrink-0 px-6 pt-6 pb-4">
				<div className="mx-auto w-full max-w-3xl">
					<div className="flex items-baseline gap-2">
						<h1 className="font-bold text-2xl text-foreground tracking-tight">
							{meta.plural}
						</h1>
						<span className="text-muted-foreground text-sm">
							{ofKind.length}
						</span>
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
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
				<div className="mx-auto w-full max-w-3xl">
					{isPending ? (
						<EntitySkeleton rows={8} />
					) : isError ? (
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
							description={`${meta.plural} appear here as Inkstone notices them in your chats and you accept the Proposal.`}
						/>
					) : items.length === 0 ? (
						<EmptyState
							icon={Search}
							title="No matches"
							description={`Nothing in ${meta.plural.toLowerCase()} matches "${query.trim()}". Try a different search.`}
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
