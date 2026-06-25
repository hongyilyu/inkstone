import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Sparkles, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { EmptyState } from "@/components/ui/empty-state";
import { useLibraryItems } from "@/lib/hooks/useLibraryItems";
import {
	activeProjectItems,
	dueSoonTodos,
	projectProgress,
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

	if (isError) {
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

	if (data.length === 0) {
		return (
			<Shell>
				<EmptyState
					icon={Sparkles}
					tone="brand"
					size="lg"
					title="Your library is empty"
					description="Library items show up here as you chat. Inkstone drafts the people, projects and todos it notices, and they land here once you accept the Proposal; bookmarks you save in the Library appear here right away."
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

	const due = dueSoonTodos(data);
	const recent = recentlyCapturedItems(data, 6);
	const projects = activeProjectItems(data).slice(0, 4);

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
								allItems={data}
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
							const { done, total } = projectProgress(data, project);
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
		</Shell>
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
