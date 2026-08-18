import { CalendarClock, Check, ChevronDown, ChevronUp } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	type LibraryItem,
	type Project,
	projectsForReview,
	reviewCadenceLabel,
} from "@/lib/libraryItems";
import { EntitySkeleton } from "./EntitySkeleton.js";

/**
 * Project Review (ADR-0031/0034): a focused, OmniFocus-style review queue on the
 * Project surface. Steps through the Projects due for review one at a time — read
 * its outcome, mark it reviewed, advance to the next.
 *
 * Session-snapshot model (grill Q12/Q13): the due-Projects queue is captured
 * once on entry and held stable for the session, so the cursor never jumps as
 * you work. A Project marked reviewed (its `next_review_at` jumps to the next
 * anchor) stays visible-but-done in the queue and the cursor advances. It
 * re-derives on re-entry (the live `["library-items"]` query refetches), not
 * mid-session.
 */
export function ProjectReviewView() {
	const { data, isError, isPending } = useLibraryItems();
	const items = data ?? [];

	// Hold the skeleton until Core data has landed, so the session-snapshot queue
	// is never seeded from an empty list before the first read resolves.
	if (isPending) {
		return (
			<ReviewFrame count={null}>
				<EntitySkeleton rows={4} />
			</ReviewFrame>
		);
	}
	// Only surface the read-failure when there's nothing cached to review. A
	// background refetch that fails while we still hold usable rows must NOT blank
	// the queue (mirrors EntityCollection's isError-with-no-data guard).
	if (isError && items.length === 0) {
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
	return <ReviewQueue items={items} />;
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
function ReviewQueue({ items }: { items: LibraryItem[] }) {
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

	// Resolve the snapshot ids to current Project rows (so review stamps within
	// the session are reflected); drop any the user deleted.
	const byId = useMemo(() => {
		const map = new Map<string, Project>();
		for (const e of items) if (e.kind === "project") map.set(e.id, e);
		return map;
	}, [items]);
	const queue = (snapshotIds ?? [])
		.map((id) => byId.get(id))
		.filter((p): p is Project => p != null);

	const [cursor, setCursor] = useState(0);

	// Session state lives HERE, not in FocusedProject: that child is keyed by
	// project.id and remounts on every cursor move, so per-project state held
	// there would reset on navigation (grill Q12 — the reviewed affordance must
	// survive stepping away and back).
	const [reviewedIds, setReviewedIds] = useState<Set<string>>(new Set());

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
		// Header count is the SNAPSHOT queue size, consistent with the body's
		// "Project {n} of {total}" — both read the frozen session queue, so the
		// screen never shows "Project 1 of 1" under "Review 0". (The documented
		// session-snapshot model — the queue holds reviewed items in place for
		// cursor stability and re-derives on re-entry.)
		<ReviewFrame count={queue.length}>
			<FocusedProject
				key={project.id}
				project={project}
				position={index}
				total={queue.length}
				reviewed={reviewedIds.has(project.id)}
				onPrev={() => goTo(index - 1)}
				onNext={() => goTo(index + 1)}
				onReviewed={() => {
					setReviewedIds((prev) => new Set(prev).add(project.id));
					goTo(index + 1);
				}}
			/>
		</ReviewFrame>
	);
}

/** The single focused Project: header (cadence · last reviewed · counter · nav ·
 * mark reviewed) over its outcome. */
function FocusedProject({
	project,
	position,
	total,
	reviewed,
	onPrev,
	onNext,
	onReviewed,
}: {
	project: Project;
	position: number;
	total: number;
	/** Marked reviewed this session (lifted to ReviewQueue so it survives nav). */
	reviewed: boolean;
	onPrev: () => void;
	onNext: () => void;
	onReviewed: () => void;
}) {
	const mutation = useEntityMutation();
	const cadence = reviewCadenceLabel(project);

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

			{project.note ? (
				<p className="whitespace-pre-wrap px-1 text-foreground text-sm">
					{project.note}
				</p>
			) : (
				<p className="px-1 py-6 text-center text-muted-foreground text-sm">
					Is this project still moving, or done? Its tasks live in TickTick.
				</p>
			)}
		</div>
	);
}
