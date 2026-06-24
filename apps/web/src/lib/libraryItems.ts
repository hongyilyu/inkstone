import {
	Bookmark as BookmarkIcon,
	BookOpenText,
	FolderKanban,
	ListTodo,
	type LucideIcon,
	User,
} from "lucide-react";
import {
	PROJECT_STATUSES,
	type ProjectStatus,
	type RecurAnchor,
	type RecurrenceUnit,
	TODO_STATUSES,
	type TodoStatus,
} from "@/lib/entityFields";

export type LibraryItemKind =
	| "journal_entry"
	| "person"
	| "project"
	| "todo"
	| "bookmark";

/**
 * Where an Entity came from ("Captured from", ADR-0030), resolved from its
 * origin `created_from` Entity Source. A Message source carries the Thread to
 * link back to; a Journal-Entry source carries the source entry's id (link to it
 * in the Library). Absent on a user-authored Entity (direct Library write).
 */
export type EntitySource =
	| { kind: "thread"; threadId: string; threadTitle: string }
	| { kind: "journal_entry"; journalEntryId: string };

interface LibraryItemBase {
	id: string;
	kind: LibraryItemKind;
	createdAt: string;
	recency: number;
	/** The Entity's capture provenance (ADR-0030); absent when user-authored. */
	source?: EntitySource;
}

export interface Person extends LibraryItemBase {
	kind: "person";
	name: string;
	/** Alternate names this Person is also known by (ADR-0031). */
	aliases?: string[];
	note?: string;
}

export interface JournalEntry extends LibraryItemBase {
	kind: "journal_entry";
	occurredAt: string;
	/**
	 * Optional end of the journaled interval (ADR-0030). Carried on the view model
	 * so the editor's full-document-replace `update_journal_entry` can round-trip a
	 * stored `ended_at` instead of silently dropping it (Core's update REPLACES the
	 * whole entry — slice-8).
	 */
	endedAt?: string;
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
	/**
	 * The complete stored Project `data` object, verbatim. The fields above are a
	 * lossy projection — they omit server-managed fields like `review_every` and
	 * `due_at`/`defer_at`. The editor needs every field to build a full-document
	 * replace `update_project` without dropping any (Core's update REPLACES the
	 * stored data, it does not merge — slice-7). Absent on test fixtures that
	 * omit the raw stored object.
	 */
	data?: Record<string, unknown>;
}

export type TodoPersonRole = "waiting_on" | "related";

/**
 * A Todo's repeat rule (ADR-0037, slimmed by ADR-0039). The view model
 * camelCases the snake_case fields Core stores in `data.recurrence`; the entity
 * codec maps between the two (`parseTodo` on the way in, `buildTodo` re-snakes it
 * on the way out). Core validates and persists the rule, and on completion
 * advances `anchor` by `interval × unit` to spawn the successor (ADR-0039).
 */
export interface RecurrenceRule {
	interval: number;
	unit: RecurrenceUnit;
	anchor: RecurAnchor;
	end?: { until?: string; afterCount?: number };
}

/** A Todo's reference to a Person, with its GTD role (ADR-0031/0032). */
export interface TodoPersonRef {
	personId: string;
	role: TodoPersonRole;
}

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
	/** Repeat rule (ADR-0037). Absent when the Todo does not recur. */
	recurrence?: RecurrenceRule;
	/** Person References (ADR-0032). Empty when the Todo links no People. */
	personRefs: TodoPersonRef[];
}

export interface Bookmark extends LibraryItemBase {
	kind: "bookmark";
	title: string;
	url?: string;
	note?: string;
	tags?: string[];
}

export type LibraryItem = JournalEntry | Person | Project | Todo | Bookmark;

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
	"bookmark",
];

/**
 * Kinds the user can manually create inline in the Library rail (ADR-0033). The
 * single source of truth for the create affordance — both the rail mount
 * (`route.tsx`) and the per-collection "New" button (`$kind.tsx`) gate on this,
 * so the two never drift.
 */
export const CREATABLE_KINDS: ReadonlySet<LibraryItemKind> = new Set([
	"todo",
	"person",
	"project",
	"journal_entry",
	"bookmark",
]);

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
	bookmark: {
		label: "Bookmark",
		plural: "Bookmarks",
		slug: "bookmarks",
		icon: BookmarkIcon,
	},
};

const SLUG_TO_KIND: Record<string, LibraryItemKind> = {
	journal: "journal_entry",
	people: "person",
	projects: "project",
	todos: "todo",
	bookmarks: "bookmark",
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
			return e.note ?? "Person";
		case "project":
			return e.outcome ?? PROJECT_STATUS_LABEL[e.status];
		case "todo":
			return e.dueAt
				? `Due ${e.dueAt.slice(0, 10)}`
				: (e.note ?? TODO_STATUS_LABEL[e.status]);
		case "bookmark":
			return bookmarkHost(e.url) ?? "Bookmark";
	}
}

/** A Bookmark's URL host for its subtitle, or null when the url is absent or unparseable. */
function bookmarkHost(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).host || null;
	} catch {
		return null;
	}
}

/**
 * A Bookmark's url as a safe, clickable href — or null when it must not be a
 * link. Core stores `url` opaque (no scheme validation, ADR-0036), so the
 * inspector guards the href itself: only http/https/mailto pass. A `javascript:`
 * or `data:` url (a stored-XSS sink) and a scheme-less string like `acme.dev`
 * (which would resolve relative to the app origin) both return null, so the
 * caller renders plain text instead of a dangerous or broken link.
 */
export function bookmarkHref(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" ||
			protocol === "https:" ||
			protocol === "mailto:"
			? url
			: null;
	} catch {
		return null;
	}
}

export const PROJECT_STATUS_LABEL = Object.fromEntries(
	PROJECT_STATUSES.map((o) => [o.value, o.label]),
) as Record<ProjectStatus, string>;

export const TODO_STATUS_LABEL = Object.fromEntries(
	TODO_STATUSES.map((o) => [o.value, o.label]),
) as Record<TodoStatus, string>;

export function libraryItemKindCounts(
	all: LibraryItem[],
): Record<LibraryItemKind, number> {
	const counts: Record<LibraryItemKind, number> = {
		journal_entry: 0,
		person: 0,
		project: 0,
		todo: 0,
		bookmark: 0,
	};
	for (const e of all) counts[e.kind] += 1;
	return counts;
}

/** All Todos in `all` (used by the derivations below). */
function allTodos(all: LibraryItem[]): Todo[] {
	return all.filter((e): e is Todo => e.kind === "todo");
}

/** Todos owned by `project` via `Todo.project_id` (ADR-0031). */
export function todosForProject(all: LibraryItem[], project: Project): Todo[] {
	return allTodos(all).filter((t) => t.projectId === project.id);
}

/** Todos that reference `person`, optionally filtered to one role (ADR-0032). */
export function todosForPerson(
	all: LibraryItem[],
	person: Person,
	role?: TodoPersonRole,
): Todo[] {
	return allTodos(all).filter((t) =>
		t.personRefs.some(
			(ref) =>
				ref.personId === person.id && (role == null || ref.role === role),
		),
	);
}

/**
 * Projects a `person` is involved in, derived through that Person's Todos:
 * Person → TodoPersonRef → Todo → Project (ADR-0031). Distinct, first-seen order.
 */
export function projectsForPerson(
	all: LibraryItem[],
	person: Person,
): Project[] {
	const projectById = new Map(
		all.filter((e): e is Project => e.kind === "project").map((p) => [p.id, p]),
	);
	const seen = new Set<string>();
	const projects: Project[] = [];
	for (const todo of todosForPerson(all, person)) {
		if (!todo.projectId || seen.has(todo.projectId)) continue;
		const project = projectById.get(todo.projectId);
		if (project) {
			seen.add(todo.projectId);
			projects.push(project);
		}
	}
	return projects;
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

/**
 * Humanize a local-datetime string (`YYYY-MM-DDTHH:MM:SS`, already local per
 * Core) for DISPLAY: date + time, no bare `T`, no seconds. The single source of
 * date-time formatting for Library inspector panels — anything user-facing
 * routes through here rather than printing the raw ISO. Returns the input
 * unchanged when it can't be parsed (no "Invalid Date" leaking to the panel).
 */
export function formatDateTime(s: string): string {
	const d = new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	return d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/**
 * Humanize a local-datetime string for DISPLAY at day granularity (no time).
 * Same parse-guard contract as `formatDateTime`. Robust to both a full
 * `YYYY-MM-DDTHH:MM:SS` and a bare date-only `YYYY-MM-DD`: a bare date is parsed
 * from its parts as a local Date, because `new Date("2026-06-19")` would land on
 * UTC midnight and render the previous day in negative-offset zones.
 */
export function formatDay(s: string): string {
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
	const d = dateOnly
		? new Date(
				Number(dateOnly[1]),
				Number(dateOnly[2]) - 1,
				Number(dateOnly[3]),
			)
		: new Date(s);
	if (Number.isNaN(d.getTime())) return s;
	return d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** Local wall-clock "now" as the `YYYY-MM-DDTHH:MM:SS` string Core dates compare against. */
export function localNowString(now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
		`T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
	);
}

/** A Todo is overdue when active and its due *day* is before today (ADR-0031).
 * Due dates are stored at midnight (`<day>T00:00:00`, see `dayToLocal`), so a
 * full-timestamp `dueAt < now` comparison would flag a todo due *today* as
 * overdue from 00:01 onward. Compare the date portion only — consistent with how
 * `dueSoonTodos` treats "due soon" as a to-the-day notion. */
export function todoIsOverdue(todo: Todo, now = localNowString()): boolean {
	return (
		todo.status === "active" &&
		todo.dueAt != null &&
		todo.dueAt.slice(0, 10) < now.slice(0, 10)
	);
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

/**
 * Inbox: active Todos with no organizing metadata — no Project, no due date,
 * and no Person References (ADR-0031). Derived, never stored. Newest first.
 */
export function inboxTodos(all: LibraryItem[]): Todo[] {
	return all
		.filter(
			(e): e is Todo =>
				e.kind === "todo" &&
				e.status === "active" &&
				e.projectId == null &&
				e.dueAt == null &&
				e.personRefs.length === 0,
		)
		.sort((a, b) => b.recency - a.recency);
}

/**
 * Waiting / Follow-up: active Todos with at least one `waiting_on` Person
 * Reference (ADR-0031). A `related`-only ref does not count. `defer_at` does
 * not remove a Todo from this view. Newest first.
 */
export function waitingTodos(all: LibraryItem[]): Todo[] {
	return all
		.filter(
			(e): e is Todo =>
				e.kind === "todo" &&
				e.status === "active" &&
				e.personRefs.some((ref) => ref.role === "waiting_on"),
		)
		.sort((a, b) => b.recency - a.recency);
}

/**
 * Project Review: active or on-hold Projects whose `next_review_at` is at or
 * before `now` (ADR-0031). Completed and dropped Projects are never reviewable.
 * Soonest-due (most overdue) first. `now` is a local wall-clock string.
 */
export function projectsForReview(
	all: LibraryItem[],
	now: string = localNowString(),
): Project[] {
	return all
		.filter(
			(e): e is Project =>
				e.kind === "project" &&
				(e.status === "active" || e.status === "on_hold") &&
				e.nextReviewAt != null &&
				e.nextReviewAt <= now,
		)
		.sort((a, b) => (a.nextReviewAt ?? "").localeCompare(b.nextReviewAt ?? ""));
}

/**
 * Human label for a Project's review cadence, read from the verbatim stored
 * `review_every` (`{interval, unit}`, ADR-0031) the projection doesn't surface.
 * "Every week" for the weekly default; "Every 2 weeks" / "Every month" otherwise.
 * `null` when the Project carries no cadence (nothing schedules its next review).
 */
export function reviewCadenceLabel(project: Project): string | null {
	const every = project.data?.review_every;
	if (!every || typeof every !== "object") return null;
	const { interval, unit } = every as { interval?: unknown; unit?: unknown };
	if (typeof interval !== "number" || typeof unit !== "string") return null;
	return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
}

/** "every minute" reads better than "minutely"; the rest take an -ly adverb. */
const RECURRENCE_ADVERB: Record<RecurrenceUnit, string> = {
	minute: "every minute",
	hour: "hourly",
	day: "daily",
	week: "weekly",
	month: "monthly",
	year: "yearly",
};

/**
 * Human-readable summary of a recurrence rule (ADR-0037). Covers interval, unit,
 * and the `end` condition (until / after_count) so a user can SEE an end that the
 * editor doesn't surface — e.g. an agent-created "repeats weekly until 2026-12-31"
 * would otherwise be invisible. Sentence case, no em dashes (DESIGN.md copy tone).
 */
export function recurrenceSummary(rule: RecurrenceRule): string {
	const cadence =
		rule.interval === 1
			? RECURRENCE_ADVERB[rule.unit]
			: `every ${rule.interval} ${rule.unit}s`;
	let summary = `Repeats ${cadence}`;
	if (rule.end?.until) {
		summary += ` until ${rule.end.until.slice(0, 10)}`;
	} else if (typeof rule.end?.afterCount === "number") {
		const n = rule.end.afterCount;
		summary += `, ${n} ${n === 1 ? "time" : "times"}`;
	}
	return summary;
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
