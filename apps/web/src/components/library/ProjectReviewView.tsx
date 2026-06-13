import {
	CalendarClock,
	Check,
	ChevronDown,
	ChevronUp,
	Circle,
	CircleCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	type LibraryItem,
	localNowString,
	type Project,
	projectsForReview,
	reviewCadenceLabel,
	type Todo,
	todosForProject,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { EntitySkeleton } from "./EntitySkeleton.js";

/**
 * Project Review (ADR-0031/0034): a focused, OmniFocus-style review queue.
 * Steps through the Projects due for review one at a time — read its next
 * actions, tick off finished todos, mark it reviewed, advance to the next.
 *
 * Session-snapshot model (grill Q12/Q13): the due-Projects queue is captured
 * once on entry and held stable for the session, so the cursor never jumps as
 * you work. A Project marked reviewed (its `next_review_at` jumps to the next
 * anchor) stays visible-but-done in the queue and the cursor advances; a todo
 * completed inline stays checked in place. Both re-derive on re-entry (the live
 * `["library-items"]` query refetches), not mid-session.
 *
 * `selectedId`/`onSelect` carry the selected *todo* via `?id`, so the shared
 * Library rail renders its `TodoDetail` — the project cursor is local state.
 */
export function ProjectReviewView({
	selectedId,
	onSelect,
}: {
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const { data, isError, isPlaceholderData } = useLibraryItems();
	const items = data ?? [];

	// Hold the skeleton until REAL Core data has landed. `useLibraryItems` seeds
	// `placeholderData` (mock preview rows) with isPending=false, so we gate on
	// the placeholder flag instead — snapshotting the queue off preview projects
	// would freeze ids that vanish when the live data replaces them.
	if (isPlaceholderData) {
		return (
			<ReviewFrame count={null}>
				<EntitySkeleton rows={4} />
			</ReviewFrame>
		);
	}
	if (isError) {
		return (
			<ReviewFrame count={null}>
				<EmptyState
					icon={CalendarClock}
					tone="danger"
					title="Couldn't load review"
					description="Something went wrong reading your workspace. Try reloading."
				/>
			</ReviewFrame>
		);
	}
	return (
		<ReviewQueue items={items} selectedId={selectedId} onSelect={onSelect} />
	);
}

/** The titled Review frame: header + a centered content column. */
function ReviewFrame({
	count,
	children,
}: {
	count: number | null;
	children: React.ReactNode;
}) {
	return (
		<section aria-label="Review" className="flex h-full min-h-0 flex-col">
			<header className="shrink-0 px-6 pt-6 pb-4">
				<div className="mx-auto w-full max-w-3xl">
					<div className="flex items-baseline gap-2">
						<h1 className="font-bold text-2xl text-foreground tracking-tight">
							Review
						</h1>
						{count != null ? (
							<span className="text-muted-foreground text-sm">{count}</span>
						) : null}
					</div>
					<p className="mt-1 text-muted-foreground text-sm">
						Active and on-hold projects due for a periodic check-in.
					</p>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
				<div className="mx-auto w-full max-w-3xl">{children}</div>
			</div>
		</section>
	);
}

/**
 * The session-snapshot queue. Freezes the due-Projects list on first render
 * (keyed by the project ids that were due), tracks the cursor locally, and
 * advances it when a Project is marked reviewed.
 */
function ReviewQueue({
	items,
	selectedId,
	onSelect,
}: {
	items: LibraryItem[];
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	// Snapshot the due-Project ids ONCE: the first time we see a non-empty due
	// list, freeze that order for the session. Marking reviewed re-derives the
	// live list (the Project's next_review_at jumps forward, so it leaves
	// `projectsForReview`), but the snapshot keeps it in the queue so the cursor
	// stays put and the user can step back to it (grill Q12).
	const liveDue = projectsForReview(items);
	const [snapshotIds, setSnapshotIds] = useState<string[] | null>(null);
	if (snapshotIds === null && liveDue.length > 0) {
		setSnapshotIds(liveDue.map((p) => p.id));
	}

	// Resolve the snapshot ids to current Project rows (so todo edits/review
	// stamps within the session are reflected); drop any the user deleted.
	const byId = useMemo(() => {
		const map = new Map<string, Project>();
		for (const e of items) if (e.kind === "project") map.set(e.id, e);
		return map;
	}, [items]);
	const queue = (snapshotIds ?? [])
		.map((id) => byId.get(id))
		.filter((p): p is Project => p != null);

	const [cursor, setCursor] = useState(0);

	if (queue.length === 0) {
		return (
			<ReviewFrame count={0}>
				<EmptyState
					icon={CalendarClock}
					title="All caught up"
					description="No projects are due for review right now. They reappear here on their next review date."
				/>
			</ReviewFrame>
		);
	}

	const index = Math.min(cursor, queue.length - 1);
	const project = queue[index];
	if (!project) return null;

	const goTo = (next: number) =>
		setCursor(Math.max(0, Math.min(next, queue.length - 1)));

	return (
		<ReviewFrame count={queue.length}>
			<FocusedProject
				key={project.id}
				project={project}
				allItems={items}
				position={index}
				total={queue.length}
				selectedTodoId={selectedId}
				onSelectTodo={onSelect}
				onPrev={() => goTo(index - 1)}
				onNext={() => goTo(index + 1)}
				onReviewed={() => goTo(index + 1)}
			/>
		</ReviewFrame>
	);
}

/** The single focused Project: header (cadence · last reviewed · counter · nav ·
 * mark reviewed) over its next-action todos. */
function FocusedProject({
	project,
	allItems,
	position,
	total,
	selectedTodoId,
	onSelectTodo,
	onPrev,
	onNext,
	onReviewed,
}: {
	project: Project;
	allItems: LibraryItem[];
	position: number;
	total: number;
	selectedTodoId: string | null;
	onSelectTodo: (id: string) => void;
	onPrev: () => void;
	onNext: () => void;
	onReviewed: () => void;
}) {
	const mutation = useEntityMutation();
	const cadence = reviewCadenceLabel(project);
	const reviewed = mutation.isSuccess;

	// Active todos, plus any completed in THIS session (so a just-ticked todo
	// stays visible-but-checked rather than vanishing under the cursor — grill
	// Q13). `sessionDone` holds ids completed via the inline toggle here.
	const [sessionDone, setSessionDone] = useState<Set<string>>(new Set());
	const todos = todosForProject(allItems, project).filter(
		(t) => t.status === "active" || sessionDone.has(t.id),
	);

	const markReviewed = () =>
		mutation.mutate(
			{
				mutation_kind: "mark_project_reviewed",
				payload: { entity_id: project.id },
			},
			{ onSuccess: onReviewed },
		);

	return (
		<div className="flex flex-col gap-4">
			<header className="flex flex-col gap-2 border-border border-b pb-4">
				<div className="flex items-start justify-between gap-3">
					<h2 className="min-w-0 font-bold text-foreground text-lg tracking-tight">
						{project.name}
					</h2>
					<div className="flex shrink-0 items-center gap-1">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Previous project"
							disabled={position === 0}
							onClick={onPrev}
						>
							<ChevronUp className="size-4" aria-hidden />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Next project"
							disabled={position === total - 1}
							onClick={onNext}
						>
							<ChevronDown className="size-4" aria-hidden />
						</Button>
						<Button
							variant="primary-icon"
							size="sm"
							disabled={mutation.isPending || reviewed}
							onClick={markReviewed}
						>
							<Check className="size-4" aria-hidden />
							{reviewed ? "Reviewed" : "Mark reviewed"}
						</Button>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
					<span>
						Project {position + 1} of {total}
					</span>
					{cadence ? <span>{cadence}</span> : null}
					{project.lastReviewedAt ? (
						<span>Last reviewed {project.lastReviewedAt.slice(0, 10)}</span>
					) : (
						<span>Never reviewed</span>
					)}
				</div>
				{project.outcome ? (
					<p className="text-muted-foreground text-sm">{project.outcome}</p>
				) : null}
				{mutation.isError ? (
					<p role="alert" className="text-destructive text-xs">
						{mutation.error instanceof Error && mutation.error.message
							? mutation.error.message
							: "Couldn't mark reviewed. Try again."}
					</p>
				) : null}
			</header>

			{todos.length === 0 ? (
				<p className="px-1 py-6 text-center text-muted-foreground text-sm">
					No active todos. Is this project still moving, or done?
				</p>
			) : (
				<ul className="flex flex-col gap-1">
					{todos.map((todo) => (
						<ReviewTodoRow
							key={todo.id}
							todo={todo}
							selected={todo.id === selectedTodoId}
							onSelect={onSelectTodo}
							onCompleted={(id) =>
								setSessionDone((prev) => new Set(prev).add(id))
							}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * A todo row inside the focused review: a clickable status circle that toggles
 * active↔completed via `update_todo` (grill Q11), plus a body button that opens
 * the todo in the shared rail. The circle is its own button so it does not nest
 * inside the selecting button.
 */
function ReviewTodoRow({
	todo,
	selected,
	onSelect,
	onCompleted,
}: {
	todo: Todo;
	selected: boolean;
	onSelect: (id: string) => void;
	onCompleted: (id: string) => void;
}) {
	const mutation = useEntityMutation();
	// Render as done when the stored status is completed OR this row's own
	// completion just succeeded (optimistic): the live `["library-items"]`
	// refetch lands a tick later, so without this the just-ticked row would flash
	// back to active. `sessionDone` (in the parent) keeps it VISIBLE; this keeps
	// it CHECKED (grill Q13).
	const done = todo.status === "completed" || mutation.isSuccess;

	const toggle = () => {
		if (done || mutation.isPending) return;
		mutation.mutate(
			{
				mutation_kind: "update_todo",
				payload: {
					todo_id: todo.id,
					todo: { status: "completed", completed_at: localNowString() },
				},
			},
			{ onSuccess: () => onCompleted(todo.id) },
		);
	};

	return (
		<li className="group flex items-stretch gap-1">
			<span className="flex w-9 shrink-0 items-center justify-center">
				<button
					type="button"
					onClick={toggle}
					disabled={done || mutation.isPending}
					aria-label={done ? "Completed" : "Mark todo complete"}
					className="rounded-full focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
				>
					{done ? (
						<CircleCheck className="size-[18px] text-primary" aria-hidden />
					) : (
						<Circle
							className="size-[18px] text-muted-foreground transition-colors hover:text-primary"
							aria-hidden
						/>
					)}
				</button>
			</span>
			<button
				type="button"
				onClick={() => onSelect(todo.id)}
				aria-current={selected ? "true" : undefined}
				className={cn(
					"flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
					"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
					selected ? "bg-secondary/70" : "hover:bg-secondary/40",
				)}
			>
				<span className="min-w-0 flex-1">
					<span
						className={cn(
							"block truncate text-sm",
							done
								? "text-muted-foreground line-through"
								: "font-medium text-foreground",
						)}
					>
						{todo.title}
					</span>
					<span className="block truncate text-muted-foreground text-xs">
						{todo.dueAt ? `Due ${todo.dueAt.slice(0, 10)}` : "No due date"}
					</span>
				</span>
			</button>
		</li>
	);
}
