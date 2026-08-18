import type { EntityBacklinksResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
	parseJournalEntry,
	parseRowsDroppingMalformed,
} from "@/lib/entityCodec";
import type { JournalEntry, LibraryItemKind } from "@/lib/libraryItems";
import { useRuntime } from "@/runtime";

/** The Entity kinds that can be an `entity_ref` target (ADR-0050) — the only two
 * that fire the backlinks read. Journal Entry is the SOURCE of mentions and
 * Media is a read-only leaf, so neither needs it. */
function targetsBacklinks(kind: LibraryItemKind): boolean {
	return kind === "person" || kind === "project";
}

/** Map an `EntityBacklinksResult` into the inspector's view-model set, dropping
 * any malformed row via the shared `parseRowsDroppingMalformed` decode policy. Pure —
 * unit-testable; the hook below only supplies the wire result. */
export function assembleBacklinks(result: EntityBacklinksResult): {
	mentionedIn: JournalEntry[];
} {
	return {
		mentionedIn: parseRowsDroppingMalformed(
			"journal_entry",
			result.mentioned_in,
			parseJournalEntry,
		),
	};
}

/**
 * The reverse relations of one Library Entity (ADR-0050), resolved authoritatively
 * by Core's `entity/backlinks` read on detail-open: the distinct Journal Entries
 * that mention it (`mentionedIn`). Only Person/Project are link targets, so the
 * query is `enabled` only for those — a JE/Media body never calls this (it passes
 * no work to the runtime).
 *
 * A Core-unreachable read REJECTS (surfacing as `isError`) rather than collapsing
 * to empty — the same discipline as `useLibraryItems`. The inspector omits the
 * "Mentioned in" section when `degraded`. A single malformed row, by contrast, is
 * dropped by `assembleBacklinks` rather than failing the read.
 */
export function useEntityBacklinks(entityId: string, kind: LibraryItemKind) {
	const runtime = useRuntime();
	const query = useQuery({
		queryKey: ["entity-backlinks", entityId],
		enabled: targetsBacklinks(kind),
		queryFn: async () => {
			const result = await runtime.runPromise(
				Effect.flatMap(WsClient, (client) => client.getBacklinks(entityId)),
			);
			return assembleBacklinks(result);
		},
	});
	// `degraded` is the inspector's fallback signal: the read failed AND no good
	// data is cached. A refetch that fails *after* a successful load (e.g. an
	// invalidation fires while Core is briefly unreachable) keeps `query.data`, so
	// the last good backlinks stay authoritative rather than blanking the section
	// on a transient blip — only a cold failure with nothing cached degrades.
	return {
		mentionedIn: query.data?.mentionedIn ?? [],
		degraded: query.isError && query.data === undefined,
	};
}
