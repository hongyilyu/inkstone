import type { JournalEntryRescanResult } from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useMutation } from "@tanstack/react-query";
import { Effect } from "effect";
import { runSquashed } from "@/lib/runSquashed";
import { useRuntime } from "@/runtime";

/**
 * Re-scan an accepted Journal Entry for mentioned-but-uncaptured entities
 * (`journal_entry/rescan`, ADR-0042). Core resolves the JE's origin Thread and
 * starts an ordinary agent Run there; the result carries the spawned `run_id`
 * and that `thread_id`, which the caller navigates to so the user watches the
 * run and sees the proposal card.
 *
 * Mirrors `useEntityMutation`: rejects with the real `WsError` via
 * {@link runSquashed}. Unlike a CRUD mutate this starts a Run rather than changing
 * the Library, so it invalidates no reads.
 */
export function useRescanJournalEntry() {
	const runtime = useRuntime();
	return useMutation<JournalEntryRescanResult, unknown, string>({
		mutationFn: (jeId) =>
			runSquashed(
				runtime,
				Effect.flatMap(WsClient, (client) => client.rescanJournalEntry(jeId)),
			),
	});
}
