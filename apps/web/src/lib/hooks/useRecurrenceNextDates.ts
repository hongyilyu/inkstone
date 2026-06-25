import { WsClient } from "@inkstone/ui-sdk";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import {
	buildRecurrencePreviewParams,
	type TodoDraft,
} from "@/lib/entityCodec";
import { useRuntime } from "@/runtime";

/** The next-occurrence preview the editor renders for a bounded recurring Todo. */
export interface RecurrenceNextDates {
	/** True when completing the Todo would spawn NO successor (series ended). */
	ended: boolean;
	/** The successor's defer date (wall-clock string), when the series continues. */
	deferAt?: string;
	/** The successor's due date (wall-clock string), when the series continues. */
	dueAt?: string;
}

/**
 * Preview where the next occurrence of a draft recurring Todo would land
 * (ADR-0039 amendment, #227), resolved authoritatively by Core's pure
 * `recurrence/preview` read so the editor never duplicates the date math. The
 * query is `enabled` only when there's something to preview — Repeats on, the
 * anchor date present, AND an End condition chosen (`buildRecurrencePreviewParams`
 * returns null otherwise, e.g. End = "never"), so an unbounded series passes no
 * work to the runtime. Returns `null` while disabled or before the first result;
 * the editor hides the block then. A failed read also yields `null` (the preview
 * is advisory — its absence degrades to nothing, never an error in the form).
 */
export function useRecurrenceNextDates(
	draft: TodoDraft,
): RecurrenceNextDates | null {
	const runtime = useRuntime();
	const params = buildRecurrencePreviewParams(draft);
	const query = useQuery({
		// Key on the wire params so the cache is stable per distinct rule+dates.
		queryKey: ["recurrence-next", params],
		enabled: params !== null,
		queryFn: async () => {
			// `enabled` guarantees params is non-null when the query runs.
			const result = await runtime.runPromise(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.recurrencePreview(
						params as NonNullable<typeof params>,
					);
				}),
			);
			return {
				ended: result.ended,
				deferAt: result.defer_at,
				dueAt: result.due_at,
			} satisfies RecurrenceNextDates;
		},
	});
	return query.data ?? null;
}
