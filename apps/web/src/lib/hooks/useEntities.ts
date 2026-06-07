import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { entities } from "@/data/mock/entities";
import type { Todo } from "@/lib/entities";
import { useRuntime } from "@/runtime";

/**
 * The Library's accepted Entities (slice 11).
 *
 * Todos go LIVE: read from Core via `entity/list_todos` and mapped to the
 * Library `Todo` view model. People / Projects / Recipes stay on the
 * `@/data/mock/entities` fixture until those entity types exist in Core (Core
 * only ever creates Todos today) — so this hook merges the live Todos with the
 * non-todo mock entities. The query key stays `["entities"]` so a proposal
 * accept can invalidate it (see `store/bridge.ts`).
 */
export function useEntities() {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["entities"],
		queryFn: async () => {
			const program = Effect.gen(function* () {
				const client = yield* WsClient;
				return yield* client.listTodos();
			});
			const { entities: rows } = await runtime.runPromise(program);
			const liveTodos = rows.map(toLibraryTodo);
			// Keep the non-todo mock collections working; only Todos are live.
			const nonTodoMocks = entities.filter((e) => e.kind !== "todo");
			return [...liveTodos, ...nonTodoMocks];
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
 * Map a live `entity/list_todos` row to the Library `Todo` view model. The view
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
