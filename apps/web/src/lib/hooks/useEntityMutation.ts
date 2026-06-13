import type {
	EntityMutateParams,
	EntityMutateResult,
} from "@inkstone/protocol";
import { WsClient } from "@inkstone/ui-sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useRuntime } from "@/runtime";

/**
 * A user-initiated `entity/mutate` (ADR-0033) that refreshes the Library on success.
 *
 * Generic over `{mutation_kind, payload}` so the rail's Todo/Person/Project/Journal
 * forms all reuse it. A `WsError` rejects the mutation (React Query's `error`); callers
 * render it. `onSuccess` invalidates `["library-items"]` so the changed Entity shows up.
 */
export function useEntityMutation() {
	const runtime = useRuntime();
	const queryClient = useQueryClient();
	return useMutation<EntityMutateResult, unknown, EntityMutateParams>({
		mutationFn: (params) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const client = yield* WsClient;
					return yield* client.entityMutate(params);
				}),
			),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: ["library-items"] }),
	});
}
