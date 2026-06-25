import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import type { LibraryItem, Todo } from "@/lib/libraryItems";
import { TodoRow } from "./EntityRow.js";
import { EntitySkeleton } from "./EntitySkeleton.js";

/**
 * A derived GTD Todo view (Inbox, Waiting/Follow-up): a titled, scrollable list
 * of Todos selected from the live Library by `select`. Selection reports the
 * row id so the shared Library rail renders detail via `?id` — same contract as
 * `EntityCollection`.
 */
export function DerivedTodoView({
	title,
	intro,
	icon,
	select,
	emptyTitle,
	emptyDescription,
	selectedId,
	onSelect,
}: {
	title: string;
	intro: string;
	icon: LucideIcon;
	/** Pure derivation from all live items to the Todos this view shows. */
	select: (all: LibraryItem[]) => Todo[];
	emptyTitle: string;
	emptyDescription: string;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const { data, isPending, isError } = useLibraryItems();
	const items = select(data ?? []);

	return (
		<section aria-label={title} className="flex h-full min-h-0 flex-col">
			<header className="shrink-0 px-6 pt-6 pb-4">
				<div className="mx-auto w-full max-w-3xl">
					<div className="flex items-baseline gap-2">
						<h1 className="font-bold text-2xl text-foreground tracking-tight">
							{title}
						</h1>
						{!isPending && !isError ? (
							<span className="text-muted-foreground text-sm">
								{items.length}
							</span>
						) : null}
					</div>
					<p className="mt-1 text-muted-foreground text-sm">{intro}</p>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
				<div className="mx-auto w-full max-w-3xl">
					{isPending ? (
						<EntitySkeleton rows={6} />
					) : isError ? (
						<EmptyState
							icon={icon}
							tone="danger"
							title={`Couldn't load ${title.toLowerCase()}`}
							description="Something went wrong reading your workspace. Try reloading."
						/>
					) : items.length === 0 ? (
						<EmptyState
							icon={icon}
							title={emptyTitle}
							description={emptyDescription}
						/>
					) : (
						<ul className="flex flex-col gap-0.5">
							{items.map((todo) => (
								<TodoRow
									key={todo.id}
									todo={todo}
									allItems={data ?? []}
									selected={todo.id === selectedId}
									onSelect={onSelect}
									onComplete={() => {}}
									onQuickDefer={() => {}}
								/>
							))}
						</ul>
					)}
				</div>
			</div>
		</section>
	);
}
