import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cause, Effect, Exit } from "effect";
import { invalidateEntityReads } from "@/lib/entityReads";
import { useRuntime } from "@/runtime";
import { showEntityCue, verbForMutationKind } from "@/store/entityCue";

/**
 * A user-initiated `entity/mutate` (ADR-0033) that refreshes the Library on success.
 *
 * Generic over `{mutation_kind, payload}` so the rail's Todo/Person/Project/Journal
 * forms all reuse it. A `WsError` rejects the mutation (React Query's `error`); callers
 * render it. `onSuccess` invalidates the entity reads (Library list + backlinks) so
 * the changed Entity shows up, then fires the success-feedback cue ("Created"/"Saved"/
 * "Deleted") for the mutation kind.
 *
 * We run via `runPromiseExit` and reject with the SQUASHED cause rather than letting
 * `runPromise` wrap the failure in Effect's `FiberFailure`. A `FiberFailure` is an
 * `Error` whose `.message` falls back to the generic "An error has occurred" when its
 * head error (here a `WsRequestError`, whose own `.message` is "") carries no text —
 * so callers reading `error.message` would surface that internal string instead of the
 * real `WsError`. Squashing hands callers the original `WsError` the docstring promises.
 */
export function useEntityMutation() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	return useMutation<EntityMutateResult, unknown, EntityMutateParams>({
		mutationFn: async (params) => {
			const exit = await runtime.runPromiseExit(
				Effect.flatMap(WsClient, (client) => client.entityMutate(params)),
			);
			if (Exit.isSuccess(exit)) return exit.value;
			throw Cause.squash(exit.cause);
		},
		// Refresh both entity reads — the Library list and any open Inspector's
		// backlink read (ADR-0050) — through the one owner of that policy, then fire
		// the success cue. The cue lives ONLY here: a thrown mutationFn routes to
		// error, so onSuccess (and the cue) never run on failure.
		onSuccess: (_data, variables) => {
			invalidateEntityReads(queryClient);
			showEntityCue(verbForMutationKind(variables.mutation_kind));
		},
	});
}
