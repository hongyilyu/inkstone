import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { entities } from "@/data/mock/entities";
import type { Person, Todo } from "@/lib/entities";
import { useRuntime } from "@/runtime";

/**
 * The Library's accepted Entities (slice 11).
 *
 * Todos and People go LIVE: read from Core via `entity/list` and mapped to the
 * Library `Todo` / `Person` view models. Projects / Recipes stay on the
 * `@/data/mock/entities` fixture until those entity types exist in Core — so
 * this hook merges the live Todos and People with the remaining (project /
 * recipe) mock entities. The query key stays `["entities"]` so a proposal
 * accept can invalidate it (see `store/bridge.ts`).
 */
export function useEntities() {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["entities"],
		queryFn: async () => {
			const program = Effect.gen(function* () {
				const client = yield* WsClient;
				const todos = yield* client.listEntities("todo");
				const people = yield* client.listEntities("person");
				return { todos: todos.entities, people: people.entities };
			});
			const { todos, people } = await runtime.runPromise(program);
			const liveTodos = todos.map(toLibraryTodo);
			const livePeople = people.map(toLibraryPerson);
			// Keep the still-mock collections working; Todos + People are live.
			const otherMocks = entities.filter(
				(e) => e.kind !== "todo" && e.kind !== "person",
			);
			return [...liveTodos, ...livePeople, ...otherMocks];
		},
	});
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
