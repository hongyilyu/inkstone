import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
	parseBookmark,
	parseJournalEntry,
	parsePerson,
	parseProject,
	parseTodo,
} from "@/lib/entityCodec";
import { useRuntime } from "@/runtime";

/** The Library's displayed items — live Journal/Todo/Person/Project/Bookmark rows
 * from Core. A Core-unreachable read REJECTS (surfacing as the query's `isError`)
 * rather than being swallowed to `[]`: an empty list and a failed read are
 * different states, and collapsing them showed every collection's first-run empty
 * copy when the workspace was merely offline. EntityCollection already renders a
 * distinct "Couldn't load" branch on `isError`. */
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
			return [
				...rows.journalEntries.map(parseJournalEntry),
				...rows.todos.map(parseTodo),
				...rows.people.map(parsePerson),
				...rows.projects.map(parseProject),
				...rows.bookmarks.map(parseBookmark),
			];
		},
	});
}
