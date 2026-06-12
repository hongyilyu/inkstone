import {
	BookOpenText,
	ChefHat,
	FolderKanban,
	ListTodo,
	type LucideIcon,
	User,
} from "lucide-react";

export type LibraryItemKind =
	| "journal_entry"
	| "person"
	| "project"
	| "todo"
	| "recipe";

export interface LibraryItemCapture {
	threadId: string;
	threadTitle: string;
	when: string;
}

interface LibraryItemBase {
	id: string;
	kind: LibraryItemKind;
	createdAt: string;
	recency: number;
	needsReview?: boolean;
	capturedFrom?: LibraryItemCapture;
}

export interface Person extends LibraryItemBase {
	kind: "person";
	name: string;
	role?: string;
	relationship?: string;
	email?: string;
	note?: string;
	projectIds?: string[];
}

export interface JournalEntry extends LibraryItemBase {
	kind: "journal_entry";
	occurredAt: string;
	body: JournalEntryBodyNode[];
}

export type JournalEntryBodyNode =
	| JournalEntryBodyTextNode
	| JournalEntryBodyEntityRefNode;

export interface JournalEntryBodyTextNode {
	type: "text";
	text: string;
}

export interface JournalEntryBodyEntityRefNode {
	type: "entity_ref";
	refId: string;
	targetEntityId?: string;
	targetKind?: Extract<LibraryItemKind, "person" | "project" | "todo">;
	targetTitle?: string;
	labelSnapshot?: string;
}

export type ProjectStatus = "active" | "on_hold" | "completed" | "dropped";

export interface Project extends LibraryItemBase {
	kind: "project";
	name: string;
	status: ProjectStatus;
	/** The desired outcome of the Project (ADR-0031). */
	outcome?: string;
	note?: string;
	/** Local wall-clock review timestamps (ADR-0031). */
	nextReviewAt?: string;
	lastReviewedAt?: string;
	personIds?: string[];
	todoIds?: string[];
}

export type TodoStatus = "active" | "completed" | "dropped";

export interface Todo extends LibraryItemBase {
	kind: "todo";
	title: string;
	note?: string;
	status: TodoStatus;
	projectId?: string;
	/** "Not before" date — local wall-clock `YYYY-MM-DDTHH:MM:SS` (ADR-0031). */
	deferAt?: string;
	/** Hard deadline — local wall-clock `YYYY-MM-DDTHH:MM:SS` (ADR-0031). */
	dueAt?: string;
	completedAt?: string;
	droppedAt?: string;
}

export interface Recipe extends LibraryItemBase {
	kind: "recipe";
	title: string;
	tags?: string[];
	time?: string;
	servings?: number;
	ingredients: string[];
	steps?: string[];
}

export type LibraryItem = JournalEntry | Person | Project | Todo | Recipe;

export interface JournalEntryDay {
	day: string;
	entries: JournalEntry[];
}

interface KindMeta {
	/** Singular noun, e.g. "Person". */
	label: string;
	/** Plural noun, e.g. "People". */
	plural: string;
	/** URL slug used by `/library/$kind`. */
	slug: string;
	icon: LucideIcon;
}

/** Display order is deliberate: journal captures first, then structured items. */
export const KIND_ORDER: LibraryItemKind[] = [
	"journal_entry",
	"person",
	"project",
	"todo",
	"recipe",
];

export const KIND_META: Record<LibraryItemKind, KindMeta> = {
	journal_entry: {
		label: "Journal Entry",
		plural: "Journal",
		slug: "journal",
		icon: BookOpenText,
	},
	person: { label: "Person", plural: "People", slug: "people", icon: User },
	project: {
		label: "Project",
		plural: "Projects",
		slug: "projects",
		icon: FolderKanban,
	},
	todo: { label: "Todo", plural: "Todos", slug: "todos", icon: ListTodo },
	recipe: {
		label: "Recipe",
		plural: "Recipes",
		slug: "recipes",
		icon: ChefHat,
	},
};

const SLUG_TO_KIND: Record<string, LibraryItemKind> = {
	journal: "journal_entry",
	people: "person",
	projects: "project",
	todos: "todo",
	recipes: "recipe",
};

export function libraryItemKindForSlug(
	slug: string,
): LibraryItemKind | undefined {
	return SLUG_TO_KIND[slug];
}

/** The user-facing title of any Library item. */
export function libraryItemTitle(e: LibraryItem): string {
	if (e.kind === "journal_entry") return journalEntryBodyText(e.body);
	return e.kind === "person" || e.kind === "project" ? e.name : e.title;
}

export function journalEntryBodyText(body: JournalEntryBodyNode[]): string {
	return body
		.map((node) =>
			node.type === "text"
				? node.text
				: (node.targetTitle ?? node.labelSnapshot ?? "Referenced entity"),
		)
		.join("");
}

/** A one-line subtitle for list rows and search results. */
export function libraryItemSubtitle(e: LibraryItem): string {
	switch (e.kind) {
		case "journal_entry":
			return e.occurredAt;
		case "person":
			return e.role ?? e.relationship ?? "Person";
		case "project":
			return e.outcome ?? PROJECT_STATUS_LABEL[e.status];
		case "todo":
			return e.dueAt
				? `Due ${e.dueAt.slice(0, 10)}`
				: (e.note ?? TODO_STATUS_LABEL[e.status]);
		case "recipe":
			return (
				[e.time, e.tags?.join(", ")].filter(Boolean).join(" · ") || "Recipe"
			);
	}
}

export const PROJECT_STATUS_LABEL: Record<Project["status"], string> = {
	active: "Active",
	on_hold: "On hold",
	completed: "Completed",
	dropped: "Dropped",
};

export const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
	active: "Active",
	completed: "Completed",
	dropped: "Dropped",
};

export function libraryItemKindCounts(
	all: LibraryItem[],
): Record<LibraryItemKind, number> {
	const counts: Record<LibraryItemKind, number> = {
		journal_entry: 0,
		person: 0,
		project: 0,
		todo: 0,
		recipe: 0,
	};
	for (const e of all) counts[e.kind] += 1;
	return counts;
}

export function todosForProject(all: LibraryItem[], project: Project): Todo[] {
	const ids = new Set(project.todoIds ?? []);
	return all.filter((e): e is Todo => e.kind === "todo" && ids.has(e.id));
}

export function peopleForProject(
	all: LibraryItem[],
	project: Project,
): Person[] {
	const ids = new Set(project.personIds ?? []);
	return all.filter((e): e is Person => e.kind === "person" && ids.has(e.id));
}

export function projectsForPerson(
	all: LibraryItem[],
	person: Person,
): Project[] {
	const ids = new Set(person.projectIds ?? []);
	return all.filter((e): e is Project => e.kind === "project" && ids.has(e.id));
}

export function projectForTodo(
	all: LibraryItem[],
	todo: Todo,
): Project | undefined {
	if (!todo.projectId) return undefined;
	return all.find(
		(e): e is Project => e.kind === "project" && e.id === todo.projectId,
	);
}

/** Most recently captured items, newest first. */
export function recentlyCapturedItems(
	all: LibraryItem[],
	limit = 6,
): LibraryItem[] {
	return [...all].sort((a, b) => b.recency - a.recency).slice(0, limit);
}

/** Accepted but unconfirmed — the "Needs review" digest, newest first. */
export function itemsNeedingReview(all: LibraryItem[]): LibraryItem[] {
	return all.filter((e) => e.needsReview).sort((a, b) => b.recency - a.recency);
}

/** Local wall-clock "now" as the `YYYY-MM-DDTHH:MM:SS` string Core dates compare against. */
export function localNowString(now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
		`T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
	);
}

/** A Todo is overdue when active with a past due date (ADR-0031). */
export function todoIsOverdue(todo: Todo, now = localNowString()): boolean {
	return todo.status === "active" && todo.dueAt != null && todo.dueAt < now;
}

/**
 * Active todos whose due *day* is at or before `now + withinDays`, overdue
 * (and earlier) first. "Due soon" is a to-the-day notion, so this compares the
 * date portion — a todo due later today still counts as due today.
 */
export function dueSoonTodos(
	all: LibraryItem[],
	withinDays = 3,
	now: Date = new Date(),
): Todo[] {
	const horizon = new Date(now);
	horizon.setDate(horizon.getDate() + withinDays);
	const horizonDay = localNowString(horizon).slice(0, 10);
	return all
		.filter(
			(e): e is Todo =>
				e.kind === "todo" &&
				e.status === "active" &&
				e.dueAt != null &&
				e.dueAt.slice(0, 10) <= horizonDay,
		)
		.sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
}

export function activeProjectItems(all: LibraryItem[]): Project[] {
	return all
		.filter(
			(e): e is Project =>
				e.kind === "project" &&
				(e.status === "active" || e.status === "on_hold"),
		)
		.sort((a, b) => b.recency - a.recency);
}

export function groupJournalEntriesByDay(
	entries: JournalEntry[],
): JournalEntryDay[] {
	const byDay = new Map<string, JournalEntry[]>();
	for (const entry of entries) {
		const day = entry.occurredAt.slice(0, 10);
		const dayEntries = byDay.get(day);
		if (dayEntries) dayEntries.push(entry);
		else byDay.set(day, [entry]);
	}

	return [...byDay.entries()]
		.sort(([a], [b]) => b.localeCompare(a))
		.map(([day, dayEntries]) => ({
			day,
			entries: [...dayEntries].sort(
				(a, b) =>
					a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id),
			),
		}));
}

export function projectProgress(
	all: LibraryItem[],
	project: Project,
): { done: number; total: number } {
	const ts = todosForProject(all, project);
	return {
		done: ts.filter((t) => t.status === "completed").length,
		total: ts.length,
	};
}

export interface LibraryItemMatch {
	item: LibraryItem;
	score: number;
}

/**
 * Rank Library items against a query. Title prefix beats word-boundary beats
 * substring; subtitle hits score lower. Empty query returns recents.
 */
export function searchLibraryItems(
	all: LibraryItem[],
	query: string,
): LibraryItem[] {
	const q = query.trim().toLowerCase();
	if (!q) return recentlyCapturedItems(all, 8);

	const matches: LibraryItemMatch[] = [];
	for (const item of all) {
		const title = libraryItemTitle(item).toLowerCase();
		const subtitle = libraryItemSubtitle(item).toLowerCase();
		let score = 0;
		if (title.startsWith(q)) score = 100;
		else if (new RegExp(`\\b${escapeRegExp(q)}`).test(title)) score = 80;
		else if (title.includes(q)) score = 60;
		else if (subtitle.includes(q)) score = 30;
		if (score > 0) matches.push({ item, score });
	}
	return matches
		.sort((a, b) => b.score - a.score || b.item.recency - a.item.recency)
		.map((m) => m.item);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
