import type { EntityBacklinksResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
	parseJournalEntry,
	parseRowsDroppingMalformed,
	parseTodo,
} from "@/lib/entityCodec";
import type { JournalEntry, LibraryItemKind, Todo } from "@/lib/libraryItems";
import { useRuntime } from "@/runtime";

/** The Entity kinds that can be an `entity_ref`/link target (ADR-0050) — the only
 * three that fire the backlinks read. Journal Entry is the SOURCE of mentions and
 * Bookmark is a read-only leaf, so neither needs it. */
function targetsBacklinks(kind: LibraryItemKind): boolean {
	return kind === "person" || kind === "project" || kind === "todo";
}

/** Map an `EntityBacklinksResult` into the inspector's two view-model sets, dropping
 * any malformed row via the shared `parseRowsDroppingMalformed` decode policy. Pure —
 * unit-testable; the hook below only supplies the wire result. */
export function assembleBacklinks(result: EntityBacklinksResult): {
	mentionedIn: JournalEntry[];
	linkedTodos: Todo[];
} {
	return {
		mentionedIn: parseRowsDroppingMalformed(
			"journal_entry",
			result.mentioned_in,
			parseJournalEntry,
		),
		linkedTodos: parseRowsDroppingMalformed(
			"todo",
			result.linked_todos,
			parseTodo,
		),
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
	// `degraded` is the inspector's fallback signal: the read failed AND no good
	// data is cached. A refetch that fails *after* a successful load (e.g. an
	// invalidation fires while Core is briefly unreachable) keeps `query.data`, so
	// the last good backlinks stay authoritative rather than flipping the sections
	// to the `allEntities` fallback on a transient blip — only a cold failure with
	// nothing cached degrades.
	return {
		mentionedIn: query.data?.mentionedIn ?? [],
		linkedTodos: query.data?.linkedTodos ?? [],
		degraded: query.isError && query.data === undefined,
	};
}
