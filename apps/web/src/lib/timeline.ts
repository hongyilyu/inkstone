import {
	groupJournalEntriesByDay,
	type JournalEntry,
	journalEntryBodyText,
	type LibraryItem,
	type LibraryItemKind,
} from "@/lib/libraryItems";

/**
 * The Timeline topic (ADR-0054 §4): a derived chronological projection over the
 * reads already on the view model. Journal Entries are the spine (grouped by
 * `occurredAt`); the People/Projects each entry touches surface as link-chips
 * read from the entry's body `entity_ref` nodes. NO new storage, no backend
 * read — this is a pure re-grouping of `useLibraryItems`.
 */

/** A People/Project a Journal Entry touches, derived from a body `entity_ref` node. */
export interface TimelineChip {
	entityId: string;
	/** entity_ref targets are person/project/todo; only these reach the chip rail. */
	kind: Extract<LibraryItemKind, "person" | "project" | "todo">;
	title: string;
}

/** One Journal Entry on the timeline, with its excerpt and the entities it touches. */
export interface TimelineEvent {
	entry: JournalEntry;
	/** The entry's body rendered as plain text (`journalEntryBodyText`). */
	excerpt: string;
	chips: TimelineChip[];
}

/** A day's worth of timeline events; days run newest-first. */
export interface TimelineDay {
	/** Local `YYYY-MM-DD` (the `groupJournalEntriesByDay` day key). */
	day: string;
	events: TimelineEvent[];
}

/**
 * The People/Project chips a Journal Entry touches, in body order, de-duplicated
 * by entity id. A ref missing its resolved `targetEntityId` / `targetKind` (an
 * unresolved mention) is dropped — a chip must link somewhere.
 */
function chipsForEntry(entry: JournalEntry): TimelineChip[] {
	const chips: TimelineChip[] = [];
	const seen = new Set<string>();
	for (const node of entry.body) {
		if (node.type !== "entity_ref") continue;
		if (!node.targetEntityId || !node.targetKind) continue;
		if (seen.has(node.targetEntityId)) continue;
		seen.add(node.targetEntityId);
		chips.push({
			entityId: node.targetEntityId,
			kind: node.targetKind,
			title: node.targetTitle ?? node.labelSnapshot ?? "Referenced entity",
		});
	}
	return chips;
}

/** Project a list of Journal Entries onto the day-grouped timeline shape. */
function daysFromEntries(entries: JournalEntry[]): TimelineDay[] {
	return groupJournalEntriesByDay(entries).map(
		({ day, entries: dayEntries }) => ({
			day,
			events: dayEntries.map((entry) => ({
				entry,
				excerpt: journalEntryBodyText(entry.body),
				chips: chipsForEntry(entry),
			})),
		}),
	);
}

/**
 * The full Timeline: every Journal Entry, grouped by occurred day (newest day
 * first, ordered within a day by occurred time — `groupJournalEntriesByDay`'s
 * semantics), each carrying its excerpt and the People/Projects it touches.
 */
export function buildTimeline(items: LibraryItem[]): TimelineDay[] {
	return daysFromEntries(
		items.filter((e): e is JournalEntry => e.kind === "journal_entry"),
	);
}

/**
 * A focused lens: only the Journal Entries whose body references `entityId`,
 * in the same day-grouped shape as `buildTimeline`. The entity's interaction
 * history — the "same entity, different lens" claim ADR-0054 §4 makes.
 */
export function focusEntityTimeline(
	items: LibraryItem[],
	entityId: string,
): TimelineDay[] {
	return daysFromEntries(
		items.filter(
			(e): e is JournalEntry =>
				e.kind === "journal_entry" &&
				e.body.some(
					(node) =>
						node.type === "entity_ref" && node.targetEntityId === entityId,
				),
		),
	);
}
