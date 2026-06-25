import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
	type LiveEntityRow,
	parseBookmark,
	parseJournalEntry,
	parsePerson,
	parseProject,
	parseRowsDroppingMalformed,
	parseTodo,
} from "@/lib/entityCodec";
import type { LibraryItem } from "@/lib/libraryItems";
import { useRuntime } from "@/runtime";

/** The five live `entity/list` row sets, one per Entity Type, as Core returns them. */
export interface LibraryRows {
	journalEntries: readonly LiveEntityRow[];
	todos: readonly LiveEntityRow[];
	people: readonly LiveEntityRow[];
	projects: readonly LiveEntityRow[];
	bookmarks: readonly LiveEntityRow[];
}

/** Map the five live row sets into one flat Library list, dropping any row that
 * fails to parse (via the shared `parseRowsDroppingMalformed` decode policy) rather
 * than failing the whole read. Pure — unit-tested directly in
 * `useLibraryItems.test.ts`; the hook below only supplies the rows. */
export function assembleLibraryItems(rows: LibraryRows): LibraryItem[] {
	return [
		...parseRowsDroppingMalformed(
			"journal_entry",
			rows.journalEntries,
			parseJournalEntry,
		),
		...parseRowsDroppingMalformed("todo", rows.todos, parseTodo),
		...parseRowsDroppingMalformed("person", rows.people, parsePerson),
		...parseRowsDroppingMalformed("project", rows.projects, parseProject),
		...parseRowsDroppingMalformed("bookmark", rows.bookmarks, parseBookmark),
	];
}

/** The Library's displayed items — live Journal/Todo/Person/Project/Bookmark rows
 * from Core. A Core-unreachable read REJECTS (surfacing as the query's `isError`)
 * rather than being swallowed to `[]`: an empty list and a failed read are
 * different states, and collapsing them showed every collection's first-run empty
 * copy when the workspace was merely offline. EntityCollection already renders a
 * distinct "Couldn't load" branch on `isError`. A single malformed row, by
 * contrast, no longer fails the read — `assembleLibraryItems` drops it. */
export function useLibraryItems() {
	const runtime = useRuntime();
	return useQuery({
		queryKey: ["library-items"],
		queryFn: async () => {
			const program = Effect.gen(function* () {
				const client = yield* WsClient;
				// Effect.all is sequential by default — set concurrency to fetch these reads concurrently.
				const [journalEntries, todos, people, projects, bookmarks] =
					yield* Effect.all(
						[
							client.listEntities("journal_entry"),
							client.listEntities("todo"),
							client.listEntities("person"),
							client.listEntities("project"),
							client.listEntities("bookmark"),
						],
						{ concurrency: 2 },
					);
				return {
					journalEntries: journalEntries.entities,
					todos: todos.entities,
					people: people.entities,
					projects: projects.entities,
					bookmarks: bookmarks.entities,
				};
			});
			// Let a Core-unreachable read reject — the query surfaces it as `isError`
			// (a distinct "Couldn't load" state), not a misleading empty Library.
			const rows = await runtime.runPromise(program);
			return assembleLibraryItems(rows);
		},
	});
}
