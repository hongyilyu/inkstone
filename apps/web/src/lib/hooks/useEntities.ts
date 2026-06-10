import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { entities } from "@/data/mock/entities";
import type { JournalEntry, Person, Todo } from "@/lib/entities";
import { useRuntime } from "@/runtime";

/**
 * The Library's accepted Entities (slice 11).
 *
 * Journal Entries go live in this slice. People and Todos keep their mock
 * fallback until extraction can populate them again; when Core has live rows
 * for either type, those live rows replace that type's mock fixture.
 */
export function useEntities() {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["entities"],
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
			const { journalEntries, todos, people } =
				await runtime.runPromise(program);
			const liveJournalEntries = journalEntries.map(toLibraryJournalEntry);
			const liveTodos = todos.map(toLibraryTodo);
			const livePeople = people.map(toLibraryPerson);
			const hasLiveTodos = liveTodos.length > 0;
			const hasLivePeople = livePeople.length > 0;
			// Keep interim mock collections working while creation is journal-only.
			const otherMocks = entities.filter(
				(e) =>
					e.kind !== "journal_entry" &&
					(e.kind !== "todo" || !hasLiveTodos) &&
					(e.kind !== "person" || !hasLivePeople),
			);
			return [
				...liveJournalEntries,
				...liveTodos,
				...livePeople,
				...otherMocks,
			];
		},
	});
}

interface JournalEntryData {
	occurred_at?: unknown;
	body?: unknown;
}

function toLibraryJournalEntry(row: {
	readonly id: string;
	readonly data: unknown;
	readonly created_at: number;
}): JournalEntry {
	const data = (row.data ?? {}) as JournalEntryData;
	const body = Array.isArray(data.body)
		? data.body
				.map((node) => {
					if (!node || typeof node !== "object") return "";
					const record = node as Record<string, unknown>;
					return record.type === "text" && typeof record.text === "string"
						? record.text
						: "";
				})
				.join("")
		: "Untitled entry";
	const title = body.trim() || "Untitled entry";
	const occurredAt =
		typeof data.occurred_at === "string" ? data.occurred_at : "Unknown time";
	return {
		id: row.id,
		kind: "journal_entry",
		occurredAt,
		body: title,
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
 * model carries fields the mock fixture invented for richer rendering
 * (`recency`, `createdAt`, `dueInDays`, …) that the live entity store does not
 * yet have; we derive the few that matter and default the rest minimally:
 *  - `title` / `done` / `due` come straight from `data`.
 *  - `recency` = `created_at` (ms-epoch) so newest sorts first, matching the
 *    mock's "higher = more recent" convention.
 *  - `createdAt` = the localized date of `created_at` (a human label).
 *  - `dueInDays`, `projectId`, `owner`, `note`, `needsReview`, `source` are
 *    left undefined — derived relationship/recency metadata the live store does
 *    not produce this slice.
 */
function toLibraryTodo(row: {
	readonly id: string;
	readonly data: unknown;
	readonly created_at: number;
}): Todo {
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
 * mock-only relationship fields (`role`, `relationship`, `email`, `projectIds`,
 * `needsReview`, `source`) are left undefined — the live store does not produce
 * them this slice (project↔person relations are out of scope).
 */
function toLibraryPerson(row: {
	readonly id: string;
	readonly data: unknown;
	readonly created_at: number;
}): Person {
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
