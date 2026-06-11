import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { entities } from "@/data/mock/entities";
import type {
	JournalEntry,
	LibraryItem,
	Person,
	Todo,
} from "@/lib/libraryItems";
import { useRuntime } from "@/runtime";

const previewItems: LibraryItem[] = entities.filter(
	(e) => e.kind !== "journal_entry",
);

interface LiveEntityRow {
	readonly id: string;
	readonly data: unknown;
	readonly created_at: number;
}

/**
 * The Library's displayed items.
 *
 * Journal Entries, People, and Todos are read from Core when present. Preview
 * rows keep the rest of the Library populated until live data covers the whole
 * surface; live rows replace preview rows per kind.
 */
export function useLibraryItems() {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["library-items"],
		placeholderData: previewItems,
		queryFn: async () => {
			const program = Effect.gen(function* () {
				const client = yield* WsClient;
				// Independent reads — fetch concurrently (Effect.all is sequential
				// by default, so set concurrency explicitly).
				const [journalEntries, todos, people] = yield* Effect.all(
					[
						client.listEntities("journal_entry"),
						client.listEntities("todo"),
						client.listEntities("person"),
					],
					{ concurrency: 2 },
				);
				return {
					journalEntries: journalEntries.entities,
					todos: todos.entities,
					people: people.entities,
				};
			});
			let rows: {
				journalEntries: readonly LiveEntityRow[];
				todos: readonly LiveEntityRow[];
				people: readonly LiveEntityRow[];
			};
			try {
				rows = await runtime.runPromise(program);
			} catch {
				// Web preview runs without Core. Keep preview items in that case;
				// strict live row validation stays below this read boundary.
				return previewItems;
			}
			const { journalEntries, todos, people } = rows;
			const liveJournalEntries = journalEntries.map(toLibraryJournalEntry);
			const liveTodos = todos.map(toLibraryTodo);
			const livePeople = people.map(toLibraryPerson);
			const hasLiveTodos = liveTodos.length > 0;
			const hasLivePeople = livePeople.length > 0;
			const remainingPreviewItems = previewItems.filter(
				(e) =>
					(e.kind !== "todo" || !hasLiveTodos) &&
					(e.kind !== "person" || !hasLivePeople),
			);
			return [
				...liveJournalEntries,
				...liveTodos,
				...livePeople,
				...remainingPreviewItems,
			];
		},
	});
}

interface JournalEntryData {
	occurred_at?: unknown;
	body?: unknown;
}

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

function toLibraryJournalEntry(row: LiveEntityRow): JournalEntry {
	const data = (row.data ?? {}) as JournalEntryData;
	if (
		typeof data.occurred_at !== "string" ||
		!LOCAL_DATETIME_RE.test(data.occurred_at)
	) {
		throw new Error(
			`Invalid journal_entry ${row.id}: occurred_at must use YYYY-MM-DDTHH:MM:SS`,
		);
	}
	if (!Array.isArray(data.body) || data.body.length === 0) {
		throw new Error(`Invalid journal_entry ${row.id}: body must not be empty`);
	}
	const body = data.body
		.map((node) => {
			if (!node || typeof node !== "object") {
				throw new Error(
					`Invalid journal_entry ${row.id}: body nodes must be objects`,
				);
			}
			const record = node as Record<string, unknown>;
			if (record.type !== "text") {
				throw new Error(
					`Invalid journal_entry ${row.id}: body supports only text nodes`,
				);
			}
			if (typeof record.text !== "string" || record.text.trim() === "") {
				throw new Error(
					`Invalid journal_entry ${row.id}: body text must not be empty`,
				);
			}
			return record.text;
		})
		.join("");
	return {
		id: row.id,
		kind: "journal_entry",
		occurredAt: data.occurred_at,
		body,
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies JournalEntry;
}

/** The Todo `data` shape Core stores (ADR-0004): `{title, done, due?}`. */
interface TodoData {
	title?: unknown;
	done?: unknown;
	due?: unknown;
}

/**
 * Map a live `entity/list` row to the Library `Todo` view model. The view
 * model carries fields the preview fixture invented for richer rendering
 * (`recency`, `createdAt`, `dueInDays`, …) that the live entity store does not
 * yet have; we derive the few that matter and default the rest minimally:
 *  - `title` / `done` / `due` come straight from `data`.
 *  - `recency` = `created_at` (ms-epoch) so newest sorts first, matching the
 *    preview fixture's "higher = more recent" convention.
 *  - `createdAt` = the localized date of `created_at` (a human label).
 *  - `dueInDays`, `projectId`, `owner`, `note`, `needsReview`, `capturedFrom` are
 *    left undefined — derived relationship/recency metadata the live store does
 *    not produce this slice.
 */
function toLibraryTodo(row: LiveEntityRow): Todo {
	const data = (row.data ?? {}) as TodoData;
	return {
		id: row.id,
		kind: "todo",
		title: typeof data.title === "string" ? data.title : "Untitled",
		done: data.done === true,
		due: typeof data.due === "string" ? data.due : undefined,
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Todo;
}

/** The Person `data` shape Core stores (CONTEXT.md): `{name, note?}`. */
interface PersonData {
	name?: unknown;
	note?: unknown;
}

/**
 * Map a live `entity/list` row to the Library `Person` view model. Mirrors
 * {@link toLibraryTodo}: `name` / `note` come straight from `data`; `recency`
 * is `created_at` (newest sorts first) and `createdAt` its localized date. The
 * preview-only relationship fields (`role`, `relationship`, `email`, `projectIds`,
 * `needsReview`, `capturedFrom`) are left undefined — the live store does not produce
 * them this slice (project↔person relations are out of scope).
 */
function toLibraryPerson(row: LiveEntityRow): Person {
	const data = (row.data ?? {}) as PersonData;
	return {
		id: row.id,
		kind: "person",
		name: typeof data.name === "string" ? data.name : "Unnamed",
		note: typeof data.note === "string" ? data.note : undefined,
		recency: row.created_at,
		createdAt: new Date(row.created_at).toLocaleDateString(),
	} satisfies Person;
}
