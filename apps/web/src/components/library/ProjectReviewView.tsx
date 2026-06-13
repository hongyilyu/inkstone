import { CalendarClock, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	type LibraryItem,
	PROJECT_STATUS_LABEL,
	peopleForProject,
	type Project,
	projectsForReview,
	todosForProject,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { EntitySkeleton } from "./EntitySkeleton.js";

/**
 * Project Review (ADR-0031): active/on-hold Projects whose review is due. Each
 * card carries a "Mark reviewed" action (ADR-0034) that stamps the review and
 * advances `next_review_at` to the next Sunday anchor, so the Project drops off
 * this list until it comes due again.
 */
export function ProjectReviewView({
	selectedId,
	onSelect,
}: {
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const { data, isPending, isError } = useLibraryItems();
	const items = data ?? [];
	const due = projectsForReview(items);

	return (
		<section aria-label="Review" className="flex h-full min-h-0 flex-col">
			<header className="shrink-0 px-6 pt-6 pb-4">
				<div className="mx-auto w-full max-w-3xl">
					<div className="flex items-baseline gap-2">
						<h1 className="font-bold text-2xl text-foreground tracking-tight">
							Review
						</h1>
						{!isPending && !isError ? (
							<span className="text-muted-foreground text-sm">
								{due.length}
							</span>
						) : null}
					</div>
					<p className="mt-1 text-muted-foreground text-sm">
						Active and on-hold projects due for a periodic check-in.
					</p>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
				<div className="mx-auto w-full max-w-3xl">
					{isPending ? (
						<EntitySkeleton rows={4} />
					) : isError ? (
						<EmptyState
							icon={CalendarClock}
							tone="danger"
							title="Couldn't load review"
							description="Something went wrong reading your workspace. Try reloading."
						/>
					) : due.length === 0 ? (
						<EmptyState
							icon={CalendarClock}
							title="All caught up"
							description="No projects are due for review right now. They reappear here on their next review date."
						/>
					) : (
						<ul className="flex flex-col gap-2">
							{due.map((project) => (
								<ReviewCard
									key={project.id}
									project={project}
									allItems={items}
									selected={project.id === selectedId}
									onSelect={onSelect}
								/>
							))}
						</ul>
					)}
				</div>
			</div>
		</section>
	);
}

function ReviewCard({
	project,
	allItems,
	selected,
	onSelect,
}: {
	project: Project;
	allItems: LibraryItem[];
	selected: boolean;
	onSelect: (id: string) => void;
}) {
	const people = peopleForProject(allItems, project);
	const hasActiveTodos = todosForProject(allItems, project).some(
		(t) => t.status === "active",
	);
	const mutation = useEntityMutation();

	return (
		<li
			className={cn(
				"flex flex-col rounded-lg border border-border transition-colors",
				selected ? "bg-secondary/70" : "hover:bg-secondary/40",
			)}
		>
			<div className="flex items-stretch gap-2">
				<button
					type="button"
					onClick={() => onSelect(project.id)}
					aria-current={selected ? "true" : undefined}
					className={cn(
						"flex min-w-0 flex-1 flex-col gap-2 rounded-tl-lg px-4 py-3 text-left",
						"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
					)}
				>
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
							{project.name}
						</span>
						<Badge size="sm" variant="secondary">
							{PROJECT_STATUS_LABEL[project.status]}
						</Badge>
					</div>
					{project.outcome ? (
						<p className="line-clamp-2 text-muted-foreground text-xs">
							{project.outcome}
						</p>
					) : null}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
						{project.nextReviewAt ? (
							<span className="inline-flex items-center gap-1">
								<CalendarClock className="size-3" aria-hidden />
								Review due {project.nextReviewAt.slice(0, 10)}
							</span>
						) : null}
						<span>
							{hasActiveTodos ? "Has active todos" : "No active todos"}
						</span>
						{people.length > 0 ? (
							<span>
								{people.length === 1
									? people[0]?.name
									: `${people.length} people`}
							</span>
						) : null}
					</div>
				</button>
				<div className="flex shrink-0 items-center pr-3 pl-1">
					<Button
						variant="ghost"
						size="sm"
						disabled={mutation.isPending}
						onClick={() =>
							mutation.mutate({
								mutation_kind: "mark_project_reviewed",
								payload: { entity_id: project.id },
							})
						}
					>
						<Check className="size-4" aria-hidden />
						Mark reviewed
					</Button>
				</div>
			</div>
			{mutation.isError ? (
				<p role="alert" className="px-4 pb-3 text-destructive text-xs">
					{mutation.error instanceof Error && mutation.error.message
						? mutation.error.message
						: "Couldn't mark reviewed. Try again."}
				</p>
			) : null}
		</li>
	);
}
