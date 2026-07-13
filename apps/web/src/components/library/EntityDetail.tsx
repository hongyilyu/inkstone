import { useNavigate } from "@tanstack/react-router";
import {
	ArrowUpRight,
	MessageSquareText,
	Pencil,
	Radar,
	Trash2,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button.js";
import { useEntityBacklinks } from "@/lib/hooks/useEntityBacklinks";
import { useEntityMutation } from "@/lib/hooks/useEntityMutation";
import { useRescanJournalEntry } from "@/lib/hooks/useRescanJournalEntry";
import type {
	JournalEntry,
	JournalEntryBodyEntityRefNode,
	LibraryItem,
	LibraryItemKind,
	Media,
	Person,
	Project,
	Todo,
} from "@/lib/libraryItems";
import {
	formatDateTime,
	formatDay,
	KIND_META,
	libraryItemSubtitle,
	libraryItemTitle,
	MEDIA_MEDIUM_LABEL,
	MEDIA_STATE_LABEL,
	mediaHref,
	PROJECT_STATUS_LABEL,
	projectForTodo,
	projectsForPerson,
	recurrenceSummary,
	TODO_STATUS_LABEL,
	type TodoPersonRole,
	todoIsOverdue,
	todosForPerson,
	todosForProject,
} from "@/lib/libraryItems";
import { cn } from "@/lib/utils.js";
import { EntityGlyph } from "./EntityGlyph.js";
import { JournalEntryEditor } from "./JournalEntryEditor.js";
import { MediaEditor } from "./MediaEditor.js";
import { PersonEditor } from "./PersonEditor.js";
import { ProjectEditor } from "./ProjectEditor.js";
import { TodoEditor } from "./TodoEditor.js";

/** Detail "Inspector" panel for one Library item: its relations as deep links and a path back to the capturing Run. */
export function EntityDetail({
	entity,
	allEntities,
}: {
	entity: LibraryItem;
	allEntities: LibraryItem[];
}) {
	// Dispatch each kind to a thin config that renders through `InspectorShell`
	// (the shell owns the shared view↔edit↔delete state machine and mutation hook).
	if (entity.kind === "todo") {
		return <TodoDetail todo={entity} allEntities={allEntities} />;
	}
	if (entity.kind === "person") {
		return <PersonDetail person={entity} allEntities={allEntities} />;
	}
	if (entity.kind === "project") {
		return <ProjectDetail project={entity} allEntities={allEntities} />;
	}
	if (entity.kind === "journal_entry") {
		return (
			<JournalEntryDetail journalEntry={entity} allEntities={allEntities} />
		);
	}
	return <MediaDetail media={entity} />;
}

/**
 * The `entity/mutate` delete kind per Library kind (ADR-0033). Derived from
 * `entity.kind` inside the shell — like `KIND_META[kind].slug` — so the entity
 * on screen is the single source of truth and a kind/delete-kind mismatch is
 * unrepresentable. The wire type is an opaque `string`; this total map is the
 * local typo guard.
 */
const DELETE_KIND: Record<LibraryItemKind, string> = {
	todo: "delete_todo",
	person: "delete_person",
	project: "delete_project",
	journal_entry: "delete_journal_entry",
	media: "delete_media",
};

/**
 * The Library inspector shell: one view↔edit↔delete state machine behind every
 * kind (ADR-0033, PRODUCT.md "approval is sacred"). Owns the `editing` /
 * `confirmingDelete` toggle, the `entity/mutate` hook, the header (glyph + title +
 * Edit chip), and the inline (non-modal) delete-confirm footer; on a successful
 * delete the Library re-reads and the route drops `?id` so the rail returns to
 * empty. The delete kind and nav slug derive from `entity.kind`; per kind only
 * the confirm sentence and the Body/Editor render props vary — the editors don't
 * share a prop shape, so the slots are render props, not a typed `<Editor entity/>`.
 * The hook lives here, reached only through this shell, so the tree stays
 * hook-free until an inspector mounts.
 */
function InspectorShell({
	entity,
	confirmCopy,
	renderBody,
	renderEditor,
}: {
	entity: LibraryItem;
	confirmCopy: string;
	renderBody: (onOpen: (e: LibraryItem) => void) => ReactNode;
	renderEditor: (onDone: () => void, onCancel: () => void) => ReactNode;
}) {
	const navigate = useNavigate();
	const [editing, setEditing] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const del = useEntityMutation();
	const meta = KIND_META[entity.kind];

	const goToEntity = (e: LibraryItem) =>
		// The Media slug ("media") collides with the static /library/media topic
		// route, so navigating to /library/$kind would resolve to the topic view and
		// LOSE the ?id selection. Route Media in-place instead (`to: "."`), so the
		// selection rides ?id on the current route and the shared rail opens it
		// (ADR-0059 slug-collision fix). Every other kind keeps its $kind collection.
		e.kind === "media"
			? navigate({ to: ".", search: { id: e.id } })
			: navigate({
					to: "/library/$kind",
					params: { kind: KIND_META[e.kind].slug },
					search: { id: e.id },
				});

	if (editing) {
		const done = () => setEditing(false);
		return (
			<div className="flex h-full flex-col bg-sidebar">
				{renderEditor(done, done)}
			</div>
		);
	}

	const deleteEntity = () =>
		del.mutate(
			{
				mutation_kind: DELETE_KIND[entity.kind],
				payload: { entity_id: entity.id },
			},
			{
				onSuccess: () =>
					// Drop `?id` so the rail returns to empty for the now-gone Entity,
					// but STAY on the current route. The detail rail is opened in-place
					// from the derived views (Today `/library`, Inbox/Waiting/Review)
					// too, so hardcoding `/library/$kind` here would yank the user out of
					// the view they were in onto the entity's kind collection. `to: "."`
					// keeps the current path and only clears the search.
					navigate({ to: ".", search: {} }),
			},
		);

	return (
		<div className="flex h-full flex-col">
			<header className="flex items-start gap-3 border-foreground/15 border-b px-5 py-4">
				<EntityGlyph entity={entity} size="lg" />
				<div className="min-w-0 flex-1 pt-0.5">
					<h2 className="truncate font-semibold text-foreground text-lg tracking-tight">
						{libraryItemTitle(entity)}
					</h2>
					<p className="truncate text-muted-foreground text-sm">
						{meta.label} · {libraryItemSubtitle(entity)}
					</p>
				</div>
				{entity.kind === "journal_entry" ? (
					<RescanChip jeId={entity.id} />
				) : null}
				<Button
					variant="chip"
					size="sm"
					onClick={() => setEditing(true)}
					aria-label={`Edit ${meta.label}`}
				>
					<Pencil className="size-3.5" aria-hidden />
					Edit
				</Button>
			</header>

			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
				{renderBody(goToEntity)}
				<CapturedFrom
					entity={entity}
					onOpenThread={(threadId, messageId) =>
						navigate({
							to: "/thread/$threadId",
							params: { threadId },
							search: messageId ? { focusedMessageId: messageId } : {},
						})
					}
				/>
			</div>

			<footer className="border-foreground/15 border-t px-5 py-4">
				{del.error ? (
					<p role="alert" className="mb-3 text-destructive text-sm">
						{del.error instanceof Error && del.error.message
							? del.error.message
							: "Couldn't delete. Try again."}
					</p>
				) : null}
				{confirmingDelete ? (
					<div className="flex items-center justify-between gap-3">
						<span className="text-foreground text-sm">{confirmCopy}</span>
						<div className="flex gap-2">
							<Button
								variant="chip"
								size="pill"
								onClick={() => {
									del.reset();
									setConfirmingDelete(false);
								}}
								disabled={del.isPending}
							>
								Cancel
							</Button>
							<Button
								variant="primary-icon"
								size="pill"
								className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
								onClick={deleteEntity}
								disabled={del.isPending}
							>
								{del.isPending ? "Deleting…" : "Delete"}
							</Button>
						</div>
					</div>
				) : (
					<Button
						variant="ghost"
						size="row"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={() => setConfirmingDelete(true)}
					>
						<Trash2 className="size-4" aria-hidden />
						Delete {meta.label}
					</Button>
				)}
			</footer>
		</div>
	);
}

/**
 * "Scan again" header chip on a Journal Entry inspector (ADR-0042). Re-runs the
 * agent over the JE's body to catch people/projects/tasks mentioned but never
 * captured, then navigates to the spawned Run's origin Thread so the user
 * watches it and decides the resulting proposal. Available on every accepted
 * Journal Entry (no gating on whether a first pass ran). Disabled while the
 * request is in flight; a failed start surfaces inline (the user stays put).
 */
function RescanChip({ jeId }: { jeId: string }) {
	const navigate = useNavigate();
	const rescan = useRescanJournalEntry();
	return (
		<div className="flex flex-col items-end gap-1">
			<Button
				variant="chip"
				size="sm"
				onClick={() =>
					rescan.mutate(jeId, {
						onSuccess: (result) =>
							navigate({
								to: "/thread/$threadId",
								params: { threadId: result.thread_id },
							}),
					})
				}
				disabled={rescan.isPending}
				aria-label="Scan again for missed entities"
			>
				<Radar className="size-3.5" aria-hidden />
				{rescan.isPending ? "Scanning…" : "Scan again"}
			</Button>
			{rescan.error ? (
				<span role="alert" className="text-destructive text-xs">
					Couldn't start scan. Try again.
				</span>
			) : null}
		</div>
	);
}

/** The Todo inspector (ADR-0033): the scheduled-task body and the full Todo editor. */
function TodoDetail({
	todo,
	allEntities,
}: {
	todo: Todo;
	allEntities: LibraryItem[];
}) {
	return (
		<InspectorShell
			entity={todo}
			confirmCopy="Delete this Todo?"
			renderBody={(onOpen) => (
				<TodoBody todo={todo} allEntities={allEntities} onOpen={onOpen} />
			)}
			renderEditor={(onDone, onCancel) => (
				<TodoEditor
					mode="edit"
					todo={todo}
					allEntities={allEntities}
					onDone={onDone}
					onCancel={onCancel}
				/>
			)}
		/>
	);
}

/** The Person inspector (ADR-0033): relations derived through Todos, edited via `PersonEditor`. */
function PersonDetail({
	person,
	allEntities,
}: {
	person: Person;
	allEntities: LibraryItem[];
}) {
	return (
		<InspectorShell
			entity={person}
			confirmCopy="Delete this Person?"
			renderBody={(onOpen) => (
				<PersonBody person={person} allEntities={allEntities} onOpen={onOpen} />
			)}
			renderEditor={(onDone, onCancel) => (
				<PersonEditor
					mode="edit"
					person={person}
					onDone={onDone}
					onCancel={onCancel}
				/>
			)}
		/>
	);
}

/**
 * The Project inspector (ADR-0033). Delete cascades server-side (Core unsets
 * `project_id` on the owning Todos), which the confirm copy spells out; the UI
 * just sends `delete_project`.
 */
function ProjectDetail({
	project,
	allEntities,
}: {
	project: Project;
	allEntities: LibraryItem[];
}) {
	return (
		<InspectorShell
			entity={project}
			confirmCopy="Delete this Project? Its Todos lose their project."
			renderBody={(onOpen) => (
				<ProjectBody
					project={project}
					allEntities={allEntities}
					onOpen={onOpen}
				/>
			)}
			renderEditor={(onDone, onCancel) => (
				<ProjectEditor
					mode="edit"
					project={project}
					onDone={onDone}
					onCancel={onCancel}
				/>
			)}
		/>
	);
}

/**
 * The Journal Entry inspector (ADR-0033). Edit threads through `JournalEntryEditor`
 * (text-body + keep/remove chips); delete sends `delete_journal_entry`.
 */
function JournalEntryDetail({
	journalEntry,
	allEntities,
}: {
	journalEntry: JournalEntry;
	allEntities: LibraryItem[];
}) {
	return (
		<InspectorShell
			entity={journalEntry}
			confirmCopy="Delete this Journal Entry?"
			renderBody={(onOpen) => (
				<JournalEntryBody
					journalEntry={journalEntry}
					allEntities={allEntities}
					onOpen={onOpen}
				/>
			)}
			renderEditor={(onDone, onCancel) => (
				<JournalEntryEditor
					mode="edit"
					journalEntry={journalEntry}
					allEntities={allEntities}
					onDone={onDone}
					onCancel={onCancel}
				/>
			)}
		/>
	);
}

/**
 * The Media inspector (ADR-0033/ADR-0059): a read-only body (no relations), edited
 * via `MediaEditor`. Intentionally passes no `allEntities` — a Media item is always
 * a direct user create (the agent never authors one, ADR-0059), so it carries no
 * Entity Source and renders no "Captured from" footer, needing no entity lookup.
 */
function MediaDetail({ media }: { media: Media }) {
	return (
		<InspectorShell
			entity={media}
			confirmCopy="Delete this Media item?"
			renderBody={() => <MediaBody media={media} />}
			renderEditor={(onDone, onCancel) => (
				<MediaEditor
					mode="edit"
					media={media}
					onDone={onDone}
					onCancel={onCancel}
				/>
			)}
		/>
	);
}

/**
 * The Inspector's "Captured from" provenance footer (ADR-0030). The chat-origin
 * link only: a Thread-sourced Entity links back to the originating chat, which
 * DESIGN.md pins as an Inspector signature (the chat→knowledge origin). A
 * Journal-Entry-sourced Entity renders nothing here — its relationship surfaces
 * canonically under "Mentioned in" via backlinks (ADR-0050) — and a user-authored
 * Entity has no source at all. The `entity_sources` row is never touched; this is
 * display only. The signature magenta is reserved for the link title (a rationed
 * "captured-from link", per DESIGN.md); the footer reads as quiet metadata, not a CTA.
 */
function CapturedFrom({
	entity,
	onOpenThread,
}: {
	entity: LibraryItem;
	onOpenThread: (threadId: string, messageId?: string) => void;
}) {
	const source = entity.source;
	if (!source || source.kind !== "thread") return null;

	return (
		<div className="-mx-2 mt-auto flex flex-col gap-1.5 border-foreground/10 border-t pt-4">
			<span className="px-2 font-medium text-muted-foreground text-xs">
				Captured from
			</span>
			{/* Clickable provenance row — same affordance vocabulary as `RelatedRow`. */}
			<button
				type="button"
				onClick={() => onOpenThread(source.threadId, source.messageId)}
				className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
			>
				<span className="shrink-0 text-muted-foreground">
					<MessageSquareText className="size-4 shrink-0" aria-hidden />
				</span>
				<span className="min-w-0 flex-1 truncate text-sm">
					<span className="font-medium text-primary">
						{source.threadTitle || "Untitled thread"}
					</span>
					<span className="text-muted-foreground"> · {entity.createdAt}</span>
				</span>
				<ArrowUpRight
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden
				/>
			</button>
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
					status === "on_hold" && "bg-primary/60",
					status === "completed" && "bg-muted-foreground/50",
					status === "dropped" && "bg-muted-foreground/30",
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
			<Field label="Occurred at">
				{formatDateTime(journalEntry.occurredAt)}
			</Field>
			{journalEntry.endedAt ? (
				<Field label="Ended at">{formatDateTime(journalEntry.endedAt)}</Field>
			) : null}
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

/** Active `waiting_on` todos for `person`, then everything else, off a todo set.
 * "Waiting on" means *actively* waiting (ADR-0031: is_waiting requires
 * status === "active"); a resolved waiting_on todo is historical and falls through
 * to "Tasks". Applied to the Core `linkedTodos` set (ADR-0050) — the same predicate
 * `todosForPerson(..., "waiting_on")` used over `allEntities`, with `personRefs`
 * riding along on each Core row. */
function splitPersonTodos(
	todos: Todo[],
	person: Person,
): { waiting: Todo[]; otherTasks: Todo[] } {
	const waiting = todos.filter(
		(t) =>
			t.status === "active" &&
			t.personRefs.some(
				(ref) => ref.personId === person.id && ref.role === "waiting_on",
			),
	);
	const waitingIds = new Set(waiting.map((t) => t.id));
	return { waiting, otherTasks: todos.filter((t) => !waitingIds.has(t.id)) };
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
	const backlinks = useEntityBacklinks(person.id, person.kind);
	// Waiting / Tasks re-source from Core's reverse lookup (ADR-0050). Only a cold
	// failure with no cached read degrades to the client-derived set over
	// `allEntities` (the exact pre-Core derivation); a transient refetch failure
	// keeps the last good Core set. Projects (Person→Projects) stays a client join
	// (ADR-0050 narrow scope).
	const tasks = backlinks.degraded
		? todosForPerson(allEntities, person)
		: backlinks.linkedTodos;
	const { waiting, otherTasks } = splitPersonTodos(tasks, person);
	const projects = projectsForPerson(allEntities, person);
	return (
		<>
			{person.aliases && person.aliases.length > 0 ? (
				<Field label="Also known as">
					<p className="text-pretty">{person.aliases.join(", ")}</p>
				</Field>
			) : null}
			{person.note ? (
				<Field label="Note">
					<p className="text-pretty">{person.note}</p>
				</Field>
			) : null}
			{waiting.length > 0 ? (
				<Field label={withCount("Waiting on", waiting.length)}>
					<div className="-mx-2 flex flex-col">
						{waiting.map((t) => (
							<RelatedRow key={t.id} entity={t} onOpen={onOpen} />
						))}
					</div>
				</Field>
			) : null}
			{otherTasks.length > 0 ? (
				<Field label={withCount("Tasks", otherTasks.length)}>
					<div className="-mx-2 flex flex-col">
						{otherTasks.map((t) => (
							<RelatedRow key={t.id} entity={t} onOpen={onOpen} />
						))}
					</div>
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
			<MentionedIn mentions={mentionsOf(backlinks)} onOpen={onOpen} />
		</>
	);
}

/** The Project's People, derived from its Todos' Person References resolved against
 * `allEntities` (Project → Todo → TodoPersonRef → Person, ADR-0031), applied to the
 * Core `linkedTodos` set (ADR-0050) — Core resolves the reverse Todo lookup; the
 * client keeps the cheap Person join. Supersedes the old `peopleForProject`, which
 * also did the Todo lookup the Core read now owns. */
function peopleFromTodos(todos: Todo[], allEntities: LibraryItem[]): Person[] {
	const personById = new Map(
		allEntities
			.filter((e): e is Person => e.kind === "person")
			.map((p) => [p.id, p]),
	);
	const seen = new Set<string>();
	const people: Person[] = [];
	for (const todo of todos) {
		for (const ref of todo.personRefs) {
			if (seen.has(ref.personId)) continue;
			const person = personById.get(ref.personId);
			if (person) {
				seen.add(ref.personId);
				people.push(person);
			}
		}
	}
	return people;
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
	const backlinks = useEntityBacklinks(project.id, project.kind);
	// Todos re-source from Core (ADR-0050); only a cold failure with no cached read
	// degrades to the client derivation over `allEntities` so the relation never
	// vanishes (a transient refetch failure keeps the last good Core set). People
	// and Progress are cheap client joins over whichever todo set is in play.
	const todos = backlinks.degraded
		? todosForProject(allEntities, project)
		: backlinks.linkedTodos;
	const people = peopleFromTodos(todos, allEntities);
	const done = todos.filter((t) => t.status === "completed").length;
	const total = todos.length;
	const pct = total === 0 ? 0 : Math.round((done / total) * 100);

	return (
		<>
			<div>
				<StatusBadge status={project.status} />
			</div>
			{project.outcome ? (
				<Field label="Outcome">
					<p className="text-pretty">{project.outcome}</p>
				</Field>
			) : null}
			{project.note ? (
				<Field label="Note">
					<p className="text-pretty">{project.note}</p>
				</Field>
			) : null}
			{project.nextReviewAt || project.lastReviewedAt ? (
				<Field label="Review">
					<p className="text-pretty">
						{project.nextReviewAt
							? `Next review ${formatDay(project.nextReviewAt)}`
							: "No next review scheduled"}
						{project.lastReviewedAt
							? ` · last reviewed ${formatDay(project.lastReviewedAt)}`
							: ""}
					</p>
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
				<Field label={withCount("Todos", todos.length)}>
					<div className="-mx-2 flex flex-col">
						{todos.map((t) => (
							<RelatedRow key={t.id} entity={t} onOpen={onOpen} />
						))}
					</div>
				</Field>
			) : null}
			<MentionedIn mentions={mentionsOf(backlinks)} onOpen={onOpen} />
		</>
	);
}

const ROLE_LABEL: Record<TodoPersonRole, string> = {
	waiting_on: "Waiting on",
	related: "Related",
};

/** A linked-Person row carrying its Todo Person Reference role (ADR-0032). */
function PersonRefRow({
	person,
	role,
	onOpen,
}: {
	person: Person;
	role: TodoPersonRole;
	onOpen: (e: LibraryItem) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onOpen(person)}
			className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-secondary/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
		>
			<EntityGlyph entity={person} size="sm" />
			<span className="min-w-0 flex-1 truncate text-foreground text-sm">
				{libraryItemTitle(person)}
			</span>
			<Badge size="sm" variant="secondary">
				{ROLE_LABEL[role]}
			</Badge>
		</button>
	);
}

/** A "· N" count suffix on a section header — quiet metadata in the existing
 * `Field` label slot (DESIGN.md: not a loud badge), matching the inspector's
 * "Progress · N of M done" voice. */
function withCount(label: string, n: number): string {
	return `${label} · ${n}`;
}

/** The "Mentioned in" set to render, or `[]` when the read errored — Mentioned-in
 * has no client equivalent on a Project, so it is simply omitted on a failed read
 * (ADR-0050 §7) rather than degraded. */
function mentionsOf(backlinks: {
	mentionedIn: JournalEntry[];
	degraded: boolean;
}): JournalEntry[] {
	return backlinks.degraded ? [] : backlinks.mentionedIn;
}

/** "Mentioned in" — the distinct Journal Entries that reference this entity, as
 * resolved by Core's `entity/backlinks` read (ADR-0050). A zero-item set renders
 * nothing (today's behavior); a non-empty set carries its count on the header. */
function MentionedIn({
	mentions,
	onOpen,
}: {
	mentions: JournalEntry[];
	onOpen: (e: LibraryItem) => void;
}) {
	if (mentions.length === 0) return null;
	return (
		<Field label={withCount("Mentioned in", mentions.length)}>
			<div className="-mx-2 flex flex-col">
				{mentions.map((entry: JournalEntry) => (
					<RelatedRow key={entry.id} entity={entry} onOpen={onOpen} />
				))}
			</div>
		</Field>
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
	// A Todo only re-sources its "Mentioned in" from Core (ADR-0050); its Project
	// and People come from the Todo's OWN row (unchanged).
	const backlinks = useEntityBacklinks(todo.id, todo.kind);
	const project = projectForTodo(allEntities, todo);
	const overdue = todoIsOverdue(todo);
	const personById = new Map(
		allEntities
			.filter((e): e is Person => e.kind === "person")
			.map((p) => [p.id, p]),
	);
	const linkedPeople = todo.personRefs
		.map((ref) => {
			const person = personById.get(ref.personId);
			return person ? { person, role: ref.role } : null;
		})
		.filter((x): x is { person: Person; role: TodoPersonRole } => x !== null);

	return (
		<>
			<div className="flex flex-wrap gap-2">
				<Badge>{TODO_STATUS_LABEL[todo.status]}</Badge>
				{todo.dueAt ? (
					<Badge variant={overdue ? "destructive" : "secondary"}>
						{overdue ? "Overdue · " : "Due "}
						{formatDay(todo.dueAt)}
					</Badge>
				) : null}
				{todo.deferAt ? (
					<Badge>Deferred to {formatDay(todo.deferAt)}</Badge>
				) : null}
				{todo.recurrence ? (
					<Badge variant="secondary">
						{recurrenceSummary(todo.recurrence)}
					</Badge>
				) : null}
				{todo.status === "completed" && todo.completedAt ? (
					<Badge variant="secondary">
						Completed {formatDay(todo.completedAt)}
					</Badge>
				) : null}
				{todo.status === "dropped" && todo.droppedAt ? (
					<Badge variant="secondary">Dropped {formatDay(todo.droppedAt)}</Badge>
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
			{linkedPeople.length > 0 ? (
				<Field label="People">
					<div className="-mx-2 flex flex-col">
						{linkedPeople.map(({ person, role }) => (
							<PersonRefRow
								key={person.id}
								person={person}
								role={role}
								onOpen={onOpen}
							/>
						))}
					</div>
				</Field>
			) : null}
			<MentionedIn mentions={mentionsOf(backlinks)} onOpen={onOpen} />
		</>
	);
}

/** Read-only Media inspector body (ADR-0059): the medium/state signature, an
 * optional finish rating/date, url as an external link, note as prose, tags as badges. */
function MediaBody({ media }: { media: Media }) {
	// Core stores `url` opaque, so only render a clickable link for a safe
	// http/https/mailto url; an unsafe (javascript:/data:) or scheme-less url
	// shows as plain text — never a dangerous or broken-relative link.
	const href = mediaHref(media.url);
	return (
		<>
			<div className="flex flex-wrap gap-2">
				<Badge variant="secondary">{MEDIA_MEDIUM_LABEL[media.medium]}</Badge>
				<Badge>{MEDIA_STATE_LABEL[media.state]}</Badge>
				{media.rating != null ? (
					// The stars are decorative; the accessible name carries the number so
					// a screen reader announces "Rated 4 out of 5", not "star star star…".
					<Badge
						variant="secondary"
						aria-label={`Rated ${media.rating} out of 5`}
					>
						<span aria-hidden>{"★".repeat(media.rating)}</span>
					</Badge>
				) : null}
				{media.finishedAt ? (
					<Badge variant="secondary">
						Finished {formatDay(media.finishedAt)}
					</Badge>
				) : null}
			</div>
			{media.url ? (
				<Field label="URL">
					{href ? (
						<a
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-1 text-primary hover:underline"
						>
							<span className="min-w-0 truncate">{media.url}</span>
							<ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
						</a>
					) : (
						<span className="block truncate text-foreground">{media.url}</span>
					)}
				</Field>
			) : null}
			{media.note ? (
				<Field label="Note">
					<p className="text-pretty">{media.note}</p>
				</Field>
			) : null}
			{media.tags && media.tags.length > 0 ? (
				<Field label="Tags">
					<div className="flex flex-wrap gap-2">
						{media.tags.map((t) => (
							<Badge key={t}>{t}</Badge>
						))}
					</div>
				</Field>
			) : null}
		</>
	);
}
