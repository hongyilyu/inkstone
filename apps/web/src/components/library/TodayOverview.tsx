import { Link, useNavigate } from "@tanstack/react-router";
import {
	ArrowUpRight,
	CalendarClock,
	ChevronRight,
	Film,
	HeartPulse,
	type LucideIcon,
	Sparkles,
	TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { EmptyState } from "@/components/ui/empty-state";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	activeProjectItems,
	dueSoonTodos,
	projectProgress,
	projectsForReview,
	recentlyCapturedItems,
} from "@/lib/libraryItems";
import { EntityGlyph } from "./EntityGlyph.js";
import { EntityRow, TodoRow } from "./EntityRow.js";
import { EntitySkeleton } from "./EntitySkeleton.js";

export function TodayOverview() {
	const { data, isPending, isError } = useLibraryItems();
	const navigate = useNavigate();

	// Select in place: set `?id` on Today so the rail shows detail without leaving.
	const open = (id: string) => {
		navigate({ to: "/library", search: { id } });
	};

	if (isPending) {
		return (
			<Shell>
				<div className="h-9 w-40 animate-pulse rounded-lg bg-secondary/70" />
				<div className="mt-10">
					<EntitySkeleton rows={5} />
				</div>
			</Shell>
		);
	}

	// Only surface the read-failure when there's nothing cached to show. A
	// background refetch that fails while we still hold usable rows must NOT blank
	// Today (mirrors EntityCollection's isError-with-no-data guard).
	if (isError && (data?.length ?? 0) === 0) {
		return (
			<Shell>
				<EmptyState
					icon={TriangleAlert}
					tone="danger"
					size="lg"
					title="Couldn't load your library"
					description="Something went wrong reading your workspace. Try reloading; your data is safe on disk."
				/>
			</Shell>
		);
	}

	// `data` is defined here (isPending returned above); the weakened isError guard
	// keeps a stale cache usable, so read through a defined local.
	const items = data ?? [];

	if (items.length === 0) {
		return (
			<Shell>
				<EmptyState
					icon={Sparkles}
					tone="brand"
					size="lg"
					title="Your library is empty"
					description="Library items show up here as you chat. Inkstone drafts the people, projects and todos it notices, and they land here once you accept the Proposal; media you save in the Library appear here right away."
					action={
						<Button
							variant="primary-icon"
							size="pill"
							onClick={() => navigate({ to: "/" })}
						>
							Start a chat
						</Button>
					}
				/>
			</Shell>
		);
	}

	const due = dueSoonTodos(items);
	const recent = recentlyCapturedItems(items, 6);
	// "In focus" means genuinely active — on-hold projects are paused, not in
	// focus, so exclude them here even though activeProjectItems keeps them (it
	// backs count contexts where on-hold still belongs).
	const projects = activeProjectItems(items)
		.filter((p) => p.status === "active")
		.slice(0, 4);
	const reviewable = projectsForReview(items);

	const summary = due.length > 0 ? `${due.length} due soon` : "";

	return (
		<Shell>
			<header
				className="motion-safe:animate-rise"
				style={{ animationDelay: "0ms" }}
			>
				<h1 className="font-bold text-3xl text-foreground tracking-tight">
					Today
				</h1>
				<p className="mt-1.5 text-muted-foreground">
					{summary || "Everything's clear. Nothing needs you right now."}
				</p>
			</header>

			{reviewable.length > 0 ? (
				<div
					className="motion-safe:animate-rise flex items-center gap-3 rounded-xl border border-border bg-secondary/30 px-4 py-3"
					style={{ animationDelay: "60ms" }}
				>
					<CalendarClock className="size-5 shrink-0 text-primary" aria-hidden />
					<div className="min-w-0 flex-1">
						<p className="font-medium text-foreground text-sm">
							{reviewable.length === 1
								? "1 project is ready for review"
								: `${reviewable.length} projects are ready for review`}
						</p>
						<p className="text-muted-foreground text-xs">
							Their review date has arrived. A quick pass keeps them current.
						</p>
					</div>
					<Link
						to="/library/gtd"
						search={{ filt: "review" }}
						className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 font-medium text-primary text-sm transition-colors hover:text-primary/80 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
						Review now
						<ArrowUpRight className="size-3.5" aria-hidden />
					</Link>
				</div>
			) : null}

			{due.length > 0 ? (
				<Section
					title="Due soon"
					count={due.length}
					delay={120}
					action={
						<ViewAll
							onClick={() =>
								navigate({ to: "/library/$kind", params: { kind: "todos" } })
							}
						/>
					}
				>
					<ul className="-mx-2 flex flex-col">
						{due.map((todo) => (
							<TodoRow
								key={todo.id}
								todo={todo}
								allItems={items}
								onSelect={open}
								onComplete={() => {}}
								onQuickDefer={() => {}}
							/>
						))}
					</ul>
				</Section>
			) : null}

			{projects.length > 0 ? (
				<Section title="In focus" count={projects.length} delay={180}>
					<div className="-mx-2 flex flex-col">
						{projects.map((project) => {
							const { done, total } = projectProgress(items, project);
							const pct = total === 0 ? 0 : Math.round((done / total) * 100);
							return (
								<button
									key={project.id}
									type="button"
									onClick={() => open(project.id)}
									className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
								>
									<EntityGlyph entity={project} size="sm" />
									<div className="min-w-0 flex-1">
										<p className="truncate font-medium text-foreground text-sm">
											{project.name}
										</p>
										<div className="mt-1.5 flex items-center gap-2">
											<span className="h-1 w-24 overflow-hidden rounded-full bg-secondary">
												<span
													className="block h-full rounded-full bg-primary"
													style={{ width: `${pct}%` }}
												/>
											</span>
											<span className="text-muted-foreground text-xs">
												{total > 0 ? `${done}/${total}` : "No todos"}
											</span>
										</div>
									</div>
								</button>
							);
						})}
					</div>
				</Section>
			) : null}

			<Section title="Recently captured" count={recent.length} delay={240}>
				<div className="-mx-2 flex flex-col">
					{recent.map((entity) => (
						<EntityRow key={entity.id} entity={entity} onSelect={open} />
					))}
				</div>
			</Section>

			{/* Cross-topic digest: calm entry points into the other topics so Today is
			    a real hub, not just the GTD core. The cards link in WITHOUT fabricating
			    any counts (ADR-0054 dec.5). */}
			<Section title="Browse topics" delay={300}>
				<div className="-mx-1 grid gap-2 sm:grid-cols-2">
					<TopicDigest
						to="/library/health"
						icon={HeartPulse}
						label="Health"
						blurb="Your recorded observations"
					/>
					<TopicDigest
						to="/library/media"
						icon={Film}
						label="Media"
						blurb="Your read & watch queue"
					/>
				</div>
			</Section>
		</Shell>
	);
}

/** One entry card in the cross-topic digest strip: a labelled link into a topic.
 * Honest copy only — `blurb` names what the topic holds without inventing any
 * stats (ADR-0054 dec.5). */
function TopicDigest({
	to,
	icon: Icon,
	label,
	blurb,
}: {
	to: "/library/health" | "/library/media";
	icon: LucideIcon;
	label: string;
	blurb: string;
}) {
	return (
		<Link
			to={to}
			className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-secondary/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
		>
			<Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
			<div className="min-w-0 flex-1">
				<p className="font-medium text-foreground text-sm">{label}</p>
				<p className="truncate text-muted-foreground text-xs">{blurb}</p>
			</div>
			<ChevronRight
				className="size-4 shrink-0 text-muted-foreground"
				aria-hidden
			/>
		</Link>
	);
}

function Shell({ children }: { children: ReactNode }) {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-9 px-6 py-10 sm:px-8">
				{children}
			</div>
		</div>
	);
}

function Section({
	title,
	count,
	action,
	delay = 0,
	children,
}: {
	title: string;
	count?: number;
	action?: ReactNode;
	delay?: number;
	children: ReactNode;
}) {
	return (
		<section
			className="motion-safe:animate-rise"
			style={{ animationDelay: `${delay}ms` }}
		>
			<div className="mb-2.5 flex items-baseline justify-between gap-3">
				<h2 className="flex items-baseline gap-2 font-semibold text-foreground text-sm">
					{title}
					{count !== undefined ? (
						<span className="text-muted-foreground text-xs">{count}</span>
					) : null}
				</h2>
				{action}
			</div>
			{children}
		</section>
	);
}

function ViewAll({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="inline-flex items-center gap-0.5 rounded-md px-1 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
		>
			View all
			<ArrowUpRight className="size-3" aria-hidden />
		</button>
	);
}
