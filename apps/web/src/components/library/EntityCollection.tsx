import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchField } from "@/components/ui/search-field";
import {
	type Entity,
	type EntityKind,
	entityTitle,
	KIND_META,
	type Project,
	searchEntities,
	type Todo,
} from "@/lib/entities";
import { useEntities } from "@/lib/hooks/useEntities";
import { cn } from "@/lib/utils.js";
import { EntityDetail } from "./EntityDetail.js";
import { EntityRow, TodoRow } from "./EntityRow.js";
import { EntitySkeleton } from "./EntitySkeleton.js";

const PROJECT_STATUS_RANK: Record<Project["status"], number> = {
	active: 0,
	review: 1,
	paused: 2,
	done: 3,
};

function compareForKind(kind: EntityKind): (a: Entity, b: Entity) => number {
	switch (kind) {
		case "person":
			return (a, b) => entityTitle(a).localeCompare(entityTitle(b));
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

/**
 * Browse one entity kind: a searchable, scannable list on the left and the
 * detail Inspector on the right. Desktop shows both; narrower widths swap the
 * list for the detail when a row is selected (graceful collapse, desktop-first).
 */
export function EntityCollection({
	kind,
	selectedId,
	onSelect,
	onClose,
}: {
	kind: EntityKind;
	selectedId: string | null;
	onSelect: (id: string) => void;
	onClose: () => void;
}) {
	const { data, isPending, isError } = useEntities();
	const [query, setQuery] = useState("");
	const meta = KIND_META[kind];

	const ofKind = useMemo(
		() => (data ?? []).filter((e) => e.kind === kind),
		[data, kind],
	);

	const items = useMemo(() => {
		if (query.trim()) return searchEntities(ofKind, query);
		return [...ofKind].sort(compareForKind(kind));
	}, [ofKind, kind, query]);

	const selected = selectedId
		? (data?.find((e) => e.id === selectedId && e.kind === kind) ?? null)
		: null;

	return (
		<div className="flex h-full min-h-0">
			<section
				aria-label={meta.plural}
				className={cn(
					"flex min-w-0 flex-1 flex-col",
					selected && "hidden lg:flex",
				)}
			>
				<header className="shrink-0 px-6 pt-6 pb-4">
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
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
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
					) : (
						<ul className="flex flex-col gap-0.5">
							{items.map((entity) =>
								entity.kind === "todo" ? (
									<TodoRow
										key={entity.id}
										todo={entity}
										selected={entity.id === selectedId}
										onSelect={onSelect}
									/>
								) : (
									<li key={entity.id}>
										<EntityRow
											entity={entity}
											selected={entity.id === selectedId}
											onSelect={onSelect}
										/>
									</li>
								),
							)}
						</ul>
					)}
				</div>
			</section>

			{selected ? (
				<aside
					aria-label={`${entityTitle(selected)} details`}
					className="min-w-0 flex-1 border-border border-l bg-card/30 motion-safe:animate-panel lg:w-[400px] lg:flex-none"
				>
					<EntityDetail
						key={selected.id}
						entity={selected}
						allEntities={data ?? []}
						onClose={onClose}
					/>
				</aside>
			) : null}
		</div>
	);
}
