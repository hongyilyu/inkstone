import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, MessageSquareText } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { CopyButton } from "@/components/CopyButton.js";
import { Badge } from "@/components/ui/badge";
import type {
	JournalEntry,
	JournalEntryBodyEntityRefNode,
	LibraryItem,
	Person,
	Project,
	Recipe,
	Todo,
} from "@/lib/libraryItems";
import {
	KIND_META,
	libraryItemSubtitle,
	libraryItemTitle,
	PROJECT_STATUS_LABEL,
	peopleForProject,
	projectForTodo,
	projectProgress,
	projectsForPerson,
	TODO_STATUS_LABEL,
	todoIsOverdue,
	todosForProject,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { setFocusedThread } from "@/store/chat";
import { EntityGlyph } from "./EntityGlyph.js";

/** Detail "Inspector" panel for one Library item: its relations as deep links and a path back to the capturing Run. */
export function EntityDetail({
	entity,
	allEntities,
}: {
	entity: LibraryItem;
	allEntities: LibraryItem[];
}) {
	const navigate = useNavigate();

	const goToEntity = (e: LibraryItem) =>
		navigate({
			to: "/library/$kind",
			params: { kind: KIND_META[e.kind].slug },
			search: { id: e.id },
		});

	const openSource = () => {
		if (!entity.capturedFrom) return;
		setFocusedThread(entity.capturedFrom.threadId);
		navigate({ to: "/" });
	};

	return (
		<div className="flex h-full flex-col">
			<header className="flex items-start gap-3 border-foreground/15 border-b px-5 py-4">
				<EntityGlyph entity={entity} size="lg" />
				<div className="min-w-0 flex-1 pt-0.5">
					<h2 className="truncate font-semibold text-foreground text-lg tracking-tight">
						{libraryItemTitle(entity)}
					</h2>
					<p className="truncate text-muted-foreground text-sm">
						{KIND_META[entity.kind].label} · {libraryItemSubtitle(entity)}
					</p>
				</div>
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
				{entity.kind === "journal_entry" && (
					<JournalEntryBody
						journalEntry={entity}
						allEntities={allEntities}
						onOpen={goToEntity}
					/>
				)}
				{entity.kind === "person" && (
					<PersonBody
						person={entity}
						allEntities={allEntities}
						onOpen={goToEntity}
					/>
				)}
				{entity.kind === "project" && (
					<ProjectBody
						project={entity}
						allEntities={allEntities}
						onOpen={goToEntity}
					/>
				)}
				{entity.kind === "todo" && (
					<TodoBody
						todo={entity}
						allEntities={allEntities}
						onOpen={goToEntity}
					/>
				)}
				{entity.kind === "recipe" && <RecipeBody recipe={entity} />}
			</div>

			{entity.capturedFrom ? (
				<footer className="border-foreground/15 border-t p-2">
					<button
						type="button"
						onClick={openSource}
						className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-secondary/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					>
						<MessageSquareText
							className="size-4 shrink-0 text-muted-foreground"
							aria-hidden
						/>
						<span className="min-w-0 flex-1">
							<span className="block text-muted-foreground text-xs">
								Captured from · {entity.capturedFrom.when}
							</span>
							<span className="block truncate text-foreground text-sm">
								{entity.capturedFrom.threadTitle}
							</span>
						</span>
						<ArrowUpRight
							className="size-4 shrink-0 text-muted-foreground"
							aria-hidden
						/>
					</button>
				</footer>
			) : null}
		</div>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-medium text-muted-foreground text-xs">{label}</span>
			<div className="text-foreground text-sm leading-relaxed">{children}</div>
		</div>
	);
}

function RelatedRow({
	entity,
	onOpen,
}: {
	entity: LibraryItem;
	onOpen: (e: LibraryItem) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onOpen(entity)}
			className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
		>
			<EntityGlyph entity={entity} size="sm" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-foreground text-sm">
					{libraryItemTitle(entity)}
				</span>
				<span className="block truncate text-muted-foreground text-xs">
					{libraryItemSubtitle(entity)}
				</span>
			</span>
			<ArrowUpRight
				className="size-3.5 shrink-0 text-muted-foreground"
				aria-hidden
			/>
		</button>
	);
}

function StatusBadge({ status }: { status: Project["status"] }) {
	return (
		<Badge className="gap-1.5">
			<span
				className={cn(
					"size-1.5 rounded-full",
					status === "active" && "bg-primary",
					status === "review" && "bg-primary/60",
					status === "paused" && "bg-muted-foreground/50",
					status === "done" && "bg-muted-foreground/30",
				)}
				aria-hidden
			/>
			{PROJECT_STATUS_LABEL[status]}
		</Badge>
	);
}

function JournalEntryBody({
	journalEntry,
	allEntities,
	onOpen,
}: {
	journalEntry: JournalEntry;
	allEntities: LibraryItem[];
	onOpen: (e: LibraryItem) => void;
}) {
	const body = renderJournalEntryBodyNodes(
		journalEntry.body,
		allEntities,
		onOpen,
	);
	return (
		<>
			<Field label="Occurred at">{journalEntry.occurredAt}</Field>
			<Field label="Body">
				<p className="text-pretty">{body}</p>
			</Field>
		</>
	);
}

function renderJournalEntryBodyNodes(
	body: JournalEntry["body"],
	allEntities: LibraryItem[],
	onOpen: (e: LibraryItem) => void,
): ReactNode[] {
	const seen = new Map<string, number>();
	return body.map((node) => {
		const keyBase =
			node.type === "text" ? `text:${node.text}` : `entity_ref:${node.refId}`;
		const count = (seen.get(keyBase) ?? 0) + 1;
		seen.set(keyBase, count);
		const key = `${keyBase}:${count}`;
		return node.type === "text" ? (
			<Fragment key={key}>{node.text}</Fragment>
		) : (
			<EntityRefChip
				key={key}
				node={node}
				allEntities={allEntities}
				onOpen={onOpen}
			/>
		);
	});
}

function EntityRefChip({
	node,
	allEntities,
	onOpen,
}: {
	node: JournalEntryBodyEntityRefNode;
	allEntities: LibraryItem[];
	onOpen: (e: LibraryItem) => void;
}) {
	const target = node.targetEntityId
		? allEntities.find((entity) => entity.id === node.targetEntityId)
		: undefined;
	const label =
		target !== undefined
			? libraryItemTitle(target)
			: (node.targetTitle ?? node.labelSnapshot ?? "Referenced entity");
	const className =
		"mx-1 inline-flex max-w-full align-baseline items-center rounded-md border border-border bg-secondary px-1.5 py-0.5 font-medium text-[0.8125rem] text-foreground leading-tight";

	if (target === undefined) {
		return <span className={className}>{label}</span>;
	}

	return (
		<button
			type="button"
			className={`${className} transition-colors hover:bg-secondary/70 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
			onClick={() => onOpen(target)}
		>
			{label}
		</button>
	);
}

function PersonBody({
	person,
	allEntities,
	onOpen,
}: {
	person: Person;
	allEntities: LibraryItem[];
	onOpen: (e: LibraryItem) => void;
}) {
	const projects = projectsForPerson(allEntities, person);
	return (
		<>
			<div className="flex flex-wrap gap-2 text-sm">
				{person.relationship ? <Badge>{person.relationship}</Badge> : null}
				{person.role ? <Badge>{person.role}</Badge> : null}
			</div>
			{person.email ? (
				<Field label="Email">
					<span className="flex items-center gap-1">
						<a
							href={`mailto:${person.email}`}
							className="truncate text-primary hover:underline"
						>
							{person.email}
						</a>
						<CopyButton text={person.email} />
					</span>
				</Field>
			) : null}
			{person.note ? (
				<Field label="Note">
					<p className="text-pretty">{person.note}</p>
				</Field>
			) : null}
			{projects.length > 0 ? (
				<Field label="Projects">
					<div className="-mx-2 flex flex-col">
						{projects.map((p) => (
							<RelatedRow key={p.id} entity={p} onOpen={onOpen} />
						))}
					</div>
				</Field>
			) : null}
		</>
	);
}

function ProjectBody({
	project,
	allEntities,
	onOpen,
}: {
	project: Project;
	allEntities: LibraryItem[];
	onOpen: (e: LibraryItem) => void;
}) {
	const people = peopleForProject(allEntities, project);
	const todos = todosForProject(allEntities, project);
	const { done, total } = projectProgress(allEntities, project);
	const pct = total === 0 ? 0 : Math.round((done / total) * 100);

	return (
		<>
			<div>
				<StatusBadge status={project.status} />
			</div>
			{project.summary ? (
				<Field label="Summary">
					<p className="text-pretty">{project.summary}</p>
				</Field>
			) : null}
			{total > 0 ? (
				<Field label={`Progress · ${done} of ${total} done`}>
					<div
						className="h-1.5 overflow-hidden rounded-full bg-secondary"
						role="progressbar"
						aria-valuenow={pct}
						aria-valuemin={0}
						aria-valuemax={100}
					>
						<div
							className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out-quint"
							style={{ width: `${pct}%` }}
						/>
					</div>
				</Field>
			) : null}
			{people.length > 0 ? (
				<Field label="People">
					<div className="-mx-2 flex flex-col">
						{people.map((p) => (
							<RelatedRow key={p.id} entity={p} onOpen={onOpen} />
						))}
					</div>
				</Field>
			) : null}
			{todos.length > 0 ? (
				<Field label="Todos">
					<div className="-mx-2 flex flex-col">
						{todos.map((t) => (
							<RelatedRow key={t.id} entity={t} onOpen={onOpen} />
						))}
					</div>
				</Field>
			) : null}
		</>
	);
}

function TodoBody({
	todo,
	allEntities,
	onOpen,
}: {
	todo: Todo;
	allEntities: LibraryItem[];
	onOpen: (e: LibraryItem) => void;
}) {
	const project = projectForTodo(allEntities, todo);
	const overdue = todoIsOverdue(todo);
	return (
		<>
			<div className="flex flex-wrap gap-2">
				<Badge>{TODO_STATUS_LABEL[todo.status]}</Badge>
				{todo.dueAt ? (
					<Badge variant={overdue ? "destructive" : "secondary"}>
						{overdue ? "Overdue · " : "Due "}
						{todo.dueAt.slice(0, 10)}
					</Badge>
				) : null}
				{todo.deferAt ? (
					<Badge>Deferred to {todo.deferAt.slice(0, 10)}</Badge>
				) : null}
			</div>
			{todo.note ? (
				<Field label="Note">
					<p className="text-pretty">{todo.note}</p>
				</Field>
			) : null}
			{project ? (
				<Field label="Project">
					<div className="-mx-2 flex flex-col">
						<RelatedRow entity={project} onOpen={onOpen} />
					</div>
				</Field>
			) : null}
		</>
	);
}

function RecipeBody({ recipe }: { recipe: Recipe }) {
	return (
		<>
			<div className="flex flex-wrap gap-2">
				{recipe.time ? <Badge>{recipe.time}</Badge> : null}
				{recipe.servings ? <Badge>Serves {recipe.servings}</Badge> : null}
				{recipe.tags?.map((t) => (
					<Badge key={t}>{t}</Badge>
				))}
			</div>
			<Field label="Ingredients">
				<ul className="flex flex-col gap-1.5">
					{recipe.ingredients.map((ing) => (
						<li key={ing} className="flex gap-2.5">
							<span
								className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground"
								aria-hidden
							/>
							<span className="text-pretty">{ing}</span>
						</li>
					))}
				</ul>
			</Field>
			{recipe.steps && recipe.steps.length > 0 ? (
				<Field label="Method">
					<ol className="flex flex-col gap-2.5">
						{recipe.steps.map((step, i) => (
							<li key={step} className="flex gap-2.5">
								<span
									className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary font-medium text-[11px] text-secondary-foreground"
									aria-hidden
								>
									{i + 1}
								</span>
								<span className="text-pretty">{step}</span>
							</li>
						))}
					</ol>
				</Field>
			) : null}
		</>
	);
}
