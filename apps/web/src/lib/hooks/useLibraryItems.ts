import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
	type LiveEntityRow,
	parseBookmark,
	parseJournalEntry,
	parsePerson,
	parseProject,
	parseTodo,
} from "@/lib/entityCodec";
import { useRuntime } from "@/runtime";

/** The Library's displayed items — live Journal/Todo/Person/Project/Bookmark rows from Core; an empty list when Core is unreachable. */
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
			let rows: {
				journalEntries: readonly LiveEntityRow[];
				todos: readonly LiveEntityRow[];
				people: readonly LiveEntityRow[];
				projects: readonly LiveEntityRow[];
				bookmarks: readonly LiveEntityRow[];
			};
			try {
				rows = await runtime.runPromise(program);
			} catch {
				// Web preview runs without Core — show an empty Library; strict live row validation stays below this read boundary.
				return [];
			}
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
