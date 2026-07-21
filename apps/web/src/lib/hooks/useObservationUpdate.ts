import type {
	ObservationUpdateParams,
	ObservationUpdateResult,
} from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { runSquashed } from "@/lib/runSquashed";
import { useRuntime } from "@/runtime";
import { showEntityCue } from "@/store/entityCue";

/**
 * A user-initiated `observation/update` (#256) that corrects a recorded
 * observation's fact fields in place and refreshes the Health stream on success.
 *
 * The draft is a SOURCE-FREE full replacement of the mutable fields — `observation_id`
 * plus an `observation` body with `occurred_at` / `ended_at?` / `values` / `note?`. Core
 * derives the schema from the stored row and validates `values` against it; the wire
 * carries no `schema_key` and no `source` (provenance is immutable). A `WsError` rejects
 * the mutation (React Query's `error`); callers render it. `onSuccess` invalidates the
 * `["observations"]` read so the corrected value shows, then fires the "Saved" cue.
 * A `WsError` rejects via {@link runSquashed}.
 */
export function useObservationUpdate() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	return useMutation<ObservationUpdateResult, unknown, ObservationUpdateParams>(
		{
			mutationFn: (params) =>
				runSquashed(
					runtime,
					Effect.flatMap(WsClient, (client) =>
						client.observationUpdate(params),
					),
				),
			// Refetch the Health stream so the corrected value shows, then fire the
			// success cue. The cue lives ONLY here: a thrown mutationFn routes to error,
			// so onSuccess (and the cue) never run on failure.
			onSuccess: () => {
				queryClient.invalidateQueries({ queryKey: ["observations"] });
				showEntityCue("Saved");
			},
		},
	);
}
