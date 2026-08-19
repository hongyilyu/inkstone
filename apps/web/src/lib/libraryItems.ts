import type { JsonObject } from "@inkstone/protocol";
import {
	BookOpenText,
	Film,
	FolderKanban,
	type LucideIcon,
	User,
} from "lucide-react";
import {
	MEDIA_MEDIUMS,
	MEDIA_STATES,
	type MediaMedium,
	type MediaState,
	PROJECT_STATUSES,
	type ProjectStatus,
} from "@/lib/entityFields";
import { asNumber, asObject, asString } from "@/lib/readPayload";

export type LibraryItemKind = "journal_entry" | "person" | "project" | "media";

/**
 * Where an Entity came from ("Captured from", ADR-0030), resolved from its
 * origin `created_from` Entity Source. A Message source carries the Thread to
 * link back to; a Journal-Entry source carries the source entry's id (link to it
 * in the Library). Absent on a user-authored Entity (direct Library write).
 */
export type EntitySource =
	| {
			kind: "thread";
			threadId: string;
			threadTitle: string;
			messageId?: string;
	  }
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
	targetKind?: Extract<LibraryItemKind, "person" | "project">;
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
	data?: JsonObject;
}

/**
 * A Media item — the queue+log Entity Type (ADR-0059, replacing Bookmark): a
 * thing to read/watch, carrying a `medium`, a lifecycle `state`, and (only in a
 * terminal state) an optional finish `rating`/`finishedAt`. The view model
 * camelCases the stored snake_case `finished_at`; the codec maps between them.
 */
export interface Media extends LibraryItemBase {
	kind: "media";
	title: string;
	medium: MediaMedium;
	state: MediaState;
	/** A 1–5 finish rating; meaningful only in a terminal state (ADR-0059). */
	rating?: number;
	/** The local-datetime finish timestamp; meaningful only in a terminal state. */
	finishedAt?: string;
	url?: string;
	note?: string;
	tags?: string[];
}

export type LibraryItem = JournalEntry | Person | Project | Media;

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
	"media",
];

/**
 * Kinds the user can manually create inline in the Library rail (ADR-0033). The
 * single source of truth for the create affordance — both the rail mount
 * (`route.tsx`) and the per-collection "New" button (`$kind.tsx`) gate on this,
 * so the two never drift.
 */
export const CREATABLE_KINDS: ReadonlySet<LibraryItemKind> = new Set([
	"person",
	"project",
	"journal_entry",
	"media",
]);

export const KIND_META = {
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
	media: {
		label: "Media",
		plural: "Media",
		slug: "media",
		icon: Film,
	},
} satisfies Record<LibraryItemKind, KindMeta>;

// Slug → kind by MAP: the slug comes from the URL, and `Map.get` returns
// `undefined` for a key equal to an `Object.prototype` member ("toString").
const KIND_BY_SLUG = new Map<string, LibraryItemKind>([
	["journal", "journal_entry"],
	["people", "person"],
	["projects", "project"],
	["media", "media"],
]);

export function libraryItemKindForSlug(
	slug: string,
): LibraryItemKind | undefined {
	return KIND_BY_SLUG.get(slug);
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
			// A friendly date, not the raw `YYYY-MM-DDTHH:MM:SS` wire string (a bare-T
			// timestamp reads as a machine value in a search-result subtitle).
			return formatDay(e.occurredAt);
		case "person":
			return e.note ?? "Person";
		case "project":
			return e.outcome ?? PROJECT_STATUS_LABEL[e.status];
		case "media":
			// A link shows its host (its most identifying detail); everything else
			// reads as "<Medium> · <State>" (the queue+log signature).
			return (
				(e.medium === "link" ? mediaHost(e.url) : null) ??
				`${MEDIA_MEDIUM_LABEL[e.medium]} · ${MEDIA_STATE_LABEL[e.state]}`
			);
	}
}

/** A Media item's URL host for its subtitle, or null when the url is absent or unparseable. */
function mediaHost(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).host || null;
	} catch {
		return null;
	}
}

/**
 * A Media item's url as a safe, clickable href — or null when it must not be a
 * link. Core stores `url` opaque (no scheme validation, ADR-0059/0036), so the
 * inspector guards the href itself: only http/https/mailto pass. A `javascript:`
 * or `data:` url (a stored-XSS sink) and a scheme-less string like `acme.dev`
 * (which would resolve relative to the app origin) both return null, so the
 * caller renders plain text instead of a dangerous or broken link.
 */
export function mediaHref(url: string | undefined): string | null {
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

/** The `value → label` map of a canonical `{value,label}` domain array (the
 * entityFields domains). */
function labelsOf<V extends string>(
	options: readonly { readonly value: V; readonly label: string }[],
): Record<V, string> {
	// SAFETY: `options` covers every member of `V` by construction, so the derived
	// map is total — `Object.fromEntries` cannot express that.
	return Object.fromEntries(options.map((o) => [o.value, o.label])) as Record<
		V,
		string
	>;
}

export const PROJECT_STATUS_LABEL = labelsOf(PROJECT_STATUSES);

export const MEDIA_MEDIUM_LABEL = labelsOf(MEDIA_MEDIUMS);

export const MEDIA_STATE_LABEL = labelsOf(MEDIA_STATES);

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

/** A local day `YYYY-MM-DD`, `n` days from `now`. */
export function addDays(n: number, now: Date = new Date()): string {
	const d = new Date(now);
	d.setDate(d.getDate() + n);
	return localNowString(d).slice(0, 10);
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
 * The Today hub's glance count (ADR-0054): projects whose review is due. Tasks
 * live in TickTick (the S4 cutover), so the old inbox/due-today todo counts are
 * gone. `now` is injectable for clock-independent tests; the live hub passes
 * the real wall clock.
 */
export function todayHubStats(all: LibraryItem[], now: Date = new Date()) {
	return {
		toReview: projectsForReview(all, localNowString(now)).length,
	};
}

/**
 * Human label for a Project's review cadence, read from the verbatim stored
 * `review_every` (`{interval, unit}`, ADR-0031) the projection doesn't surface.
 * "Every week" for the weekly default; "Every 2 weeks" / "Every month" otherwise.
 * `null` when the Project carries no cadence (nothing schedules its next review).
 */
export function reviewCadenceLabel(project: Project): string | null {
	const every = asObject(project.data?.review_every);
	const interval = asNumber(every?.interval);
	const unit = asString(every?.unit);
	if (interval === undefined || unit === undefined) return null;
	return interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
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
