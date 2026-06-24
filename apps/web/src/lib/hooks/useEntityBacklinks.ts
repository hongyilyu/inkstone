import type { EntityBacklinksResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
	type LiveEntityRow,
	parseJournalEntry,
	parseTodo,
} from "@/lib/entityCodec";
import type {
	JournalEntry,
	LibraryItem,
	LibraryItemKind,
	Todo,
} from "@/lib/libraryItems";
import { useRuntime } from "@/runtime";

/** The Entity kinds that can be an `entity_ref`/link target (ADR-0050) — the only
 * three that fire the backlinks read. Journal Entry is the SOURCE of mentions and
 * Bookmark is a read-only leaf, so neither needs it. */
function targetsBacklinks(kind: LibraryItemKind): boolean {
	return kind === "person" || kind === "project" || kind === "todo";
}

/**
 * Parse a backlink row set, DROPPING (and warning about) any row that throws —
 * the exact discipline `useLibraryItems`' `parseKind` uses. `parseJournalEntry`
 * is strict (it throws on a malformed entry), so one bad "Mentioned in" row would
 * otherwise reject the whole read and blank every backlink section; dropping it
 * keeps the rest renderable. (`console.warn` is a plain browser diagnostic — Web
 * capture is out of the ADR-0038 trail.) `parseTodo` is fail-soft and never throws.
 */
function parseRows<T extends LibraryItem>(
	kind: string,
	rows: readonly LiveEntityRow[],
	parse: (row: LiveEntityRow) => T,
): T[] {
	const items: T[] = [];
	for (const row of rows) {
		try {
			items.push(parse(row));
		} catch (error) {
			console.warn(
				`Dropping unparseable ${kind} backlink row ${row.id}:`,
				error,
			);
		}
	}
	return items;
}

/** Map an `EntityBacklinksResult` into the inspector's two view-model sets. Pure —
 * unit-testable; the hook below only supplies the wire result. */
export function assembleBacklinks(result: EntityBacklinksResult): {
	mentionedIn: JournalEntry[];
	linkedTodos: Todo[];
} {
	return {
		mentionedIn: parseRows(
			"journal_entry",
			result.mentioned_in,
			parseJournalEntry,
		),
		linkedTodos: parseRows("todo", result.linked_todos, parseTodo),
	};
}

/**
 * The reverse relations of one Library Entity (ADR-0050), resolved authoritatively
 * by Core's `entity/backlinks` read on detail-open: the distinct Journal Entries
 * that mention it (`mentionedIn`) and the Todos linked to it (`linkedTodos`). Only
 * Person/Project/Todo are link targets, so the query is `enabled` only for those —
 * a JE/Bookmark body never calls this (it passes no work to the runtime).
 *
 * A Core-unreachable read REJECTS (surfacing as `isError`) rather than collapsing
 * to empty — the same discipline as `useLibraryItems`. The inspector decides the
 * fallback: it degrades the linked-todo sections to the client `todosForPerson`/
 * `todosForProject` derivations and omits "Mentioned in" (which has no client
 * equivalent on a Project). A single malformed row, by contrast, is dropped by
 * `assembleBacklinks` rather than failing the read.
 */
export function useEntityBacklinks(entityId: string, kind: LibraryItemKind) {
	const runtime = useRuntime();
	const query = useQuery({
		queryKey: ["entity-backlinks", entityId],
		enabled: targetsBacklinks(kind),
		queryFn: async () => {
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.getBacklinks(entityId);
				}),
			);
			return assembleBacklinks(result);
		},
	});
	return {
		mentionedIn: query.data?.mentionedIn ?? [],
		linkedTodos: query.data?.linkedTodos ?? [],
		isError: query.isError,
		isPending: query.isPending,
	};
}
